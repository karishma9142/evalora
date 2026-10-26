import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = ':memory:';
process.env.ENCRYPTION_KEY = 'cd'.repeat(32);

const { buildApp } = await import('../src/app.js');
const { AnthropicProvider } = await import('../src/providers/anthropic.js');
const { calcCost } = await import('../src/lib/cost.js');

// A fake AI server that speaks both the OpenAI-style and Anthropic-style APIs.
// It only answers if the right key is sent, which also proves our key decryption works.
const fake = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    const send = (status: number, obj: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    if (req.url === '/v1/chat/completions') {
      if (req.headers.authorization !== 'Bearer good-key-12345') return send(401, { error: 'bad key' });
      const last = body.messages[body.messages.length - 1].content;
      const sys = body.messages[0].role === 'system' ? body.messages[0].content : '';
      return send(200, {
        choices: [{ message: { content: `echo: ${last} | sys: ${sys}` } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
    }
    if (req.url === '/v1/messages') {
      if (req.headers['x-api-key'] !== 'anthropic-key-1234') return send(401, { error: 'bad key' });
      return send(200, {
        content: [{ type: 'text', text: `claude says: ${body.messages[0].content}` }],
        usage: { input_tokens: 7, output_tokens: 3 },
      });
    }
    send(404, { error: 'nope' });
  });
});
await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
const fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
after(() => fake.close());

const app = buildApp();
await app.ready();

async function newUser(email: string) {
  const res = await app.inject({ method: 'POST', url: '/auth/register', payload: { email, password: 'password123' } });
  return { authorization: `Bearer ${res.json().token}` };
}
async function newCredential(h: Record<string, string>, apiKey: string) {
  const res = await app.inject({
    method: 'POST', url: '/credentials', headers: h,
    payload: { label: 'fake', provider: 'openai-compatible', baseUrl: `${fakeUrl}/v1`, apiKey },
  });
  return res.json().id as string;
}

test('cost calculation', () => {
  assert.equal(calcCost(1000, 500, 3, 15), (1000 * 3 + 500 * 15) / 1e6);
  assert.equal(calcCost(1000, 500, null, null), null);
});

test('Anthropic adapter parses text and token usage', async () => {
  const p = new AnthropicProvider('anthropic-key-1234', fakeUrl);
  const r = await p.generate({ model: 'x', prompt: 'hi' });
  assert.equal(r.text, 'claude says: hi');
  assert.equal(r.inputTokens, 7);
  assert.equal(r.outputTokens, 3);
});

test('create target, run a test prompt end to end (decrypts key, calls fake AI, computes cost)', async () => {
  const h = await newUser('t1@test.com');
  const credentialId = await newCredential(h, 'good-key-12345');

  const created = await app.inject({
    method: 'POST', url: '/targets', headers: h,
    payload: { name: 'Fake GPT', credentialId, model: 'fake-1', systemPrompt: 'Be brief', inputPricePerM: 1, outputPricePerM: 2 },
  });
  assert.equal(created.statusCode, 201);

  const test1 = await app.inject({
    method: 'POST', url: `/targets/${created.json().id}/test`, headers: h,
    payload: { prompt: 'hello' },
  });
  assert.equal(test1.statusCode, 200);
  const out = test1.json();
  assert.equal(out.output, 'echo: hello | sys: Be brief');
  assert.equal(out.inputTokens, 10);
  assert.equal(out.outputTokens, 5);
  assert.equal(out.costUsd, (10 * 1 + 5 * 2) / 1e6);
  assert.ok(out.latencyMs >= 0);
});

test('wrong key gives a clean 502 without leaking the key', async () => {
  const h = await newUser('t2@test.com');
  const credentialId = await newCredential(h, 'wrong-key-99999');
  const t = await app.inject({ method: 'POST', url: '/targets', headers: h, payload: { name: 'x', credentialId, model: 'm' } });
  const res = await app.inject({ method: 'POST', url: `/targets/${t.json().id}/test`, headers: h, payload: { prompt: 'hi' } });
  assert.equal(res.statusCode, 502);
  assert.equal(res.json().error, 'provider_error');
  assert.ok(!res.body.includes('wrong-key-99999'));
});

test('tenant isolation: cannot use or test another workspace\'s credential or target', async () => {
  const alice = await newUser('alice3@test.com');
  const bob = await newUser('bob3@test.com');
  const aliceCred = await newCredential(alice, 'good-key-12345');
  const aliceTarget = (await app.inject({ method: 'POST', url: '/targets', headers: alice, payload: { name: 'a', credentialId: aliceCred, model: 'm' } })).json().id;

  const steal = await app.inject({ method: 'POST', url: '/targets', headers: bob, payload: { name: 'b', credentialId: aliceCred, model: 'm' } });
  assert.equal(steal.statusCode, 404);

  const use = await app.inject({ method: 'POST', url: `/targets/${aliceTarget}/test`, headers: bob, payload: { prompt: 'hi' } });
  assert.equal(use.statusCode, 404);

  assert.equal((await app.inject({ method: 'GET', url: '/targets', headers: bob })).json().length, 0);
});

test('cannot delete a credential that a target uses', async () => {
  const h = await newUser('t4@test.com');
  const credentialId = await newCredential(h, 'good-key-12345');
  await app.inject({ method: 'POST', url: '/targets', headers: h, payload: { name: 'x', credentialId, model: 'm' } });
  const del = await app.inject({ method: 'DELETE', url: `/credentials/${credentialId}`, headers: h });
  assert.equal(del.statusCode, 409);
});
