import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = ':memory:';
process.env.ENCRYPTION_KEY = '34'.repeat(32);

const { buildApp } = await import('../src/app.js');
const { db } = await import('../src/db.js');

// Fake AI: the model named "good-model" answers everything right,
// "weak-model" gets France and the math question wrong.
const fake = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = JSON.parse(raw);
    const prompt: string = body.messages[body.messages.length - 1].content;
    const weak = body.model === 'weak-model';
    const answer = prompt.includes('France')
      ? weak ? 'Lyon' : 'Paris'
      : prompt.includes('Japan')
        ? 'Tokyo'
        : prompt.includes('12 times')
          ? weak ? 'about a hundred' : '144'
          : 'ok';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: answer } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
});
await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
const fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`;
after(() => fake.close());

const app = buildApp();
await app.ready();

async function newUser(email: string) {
  const res = await app.inject({ method: 'POST', url: '/auth/register', payload: { email, password: 'password123' } });
  return { authorization: `Bearer ${res.json().token}` };
}

async function world(h: Record<string, string>) {
  const cred = (await app.inject({
    method: 'POST', url: '/credentials', headers: h,
    payload: { label: 'fake', provider: 'openai-compatible', baseUrl: fakeUrl, apiKey: 'any-key-12345' },
  })).json().id;
  const target = async (name: string, model: string, price = 1) =>
    (await app.inject({
      method: 'POST', url: '/targets', headers: h,
      payload: { name, credentialId: cred, model, inputPricePerM: price, outputPricePerM: price },
    })).json().id as string;
  const suite = (await app.inject({ method: 'POST', url: '/suites', headers: h, payload: { name: 's' } })).json().id as string;
  await app.inject({
    method: 'POST', url: `/suites/${suite}/cases`, headers: h,
    payload: {
      cases: [
        { input: 'Capital of France?', expected: 'Paris', graders: [{ type: 'contains' }] },
        { input: 'Capital of Japan?', expected: 'Tokyo', graders: [{ type: 'contains' }] },
        { input: 'What is 12 times 12?', expected: '144', graders: [{ type: 'contains' }] },
      ],
    },
  });
  return { suite, good: await target('Good', 'good-model'), weak: await target('Weak', 'weak-model', 2) };
}

async function finishedRun(h: Record<string, string>, suiteId: string, targetId: string, extra: object = {}) {
  const id = (await app.inject({ method: 'POST', url: '/runs', headers: h, payload: { suiteId, targetId, ...extra } })).json().id as string;
  for (let i = 0; i < 150; i++) {
    const row = db.prepare('SELECT status FROM runs WHERE id = ?').get(id) as { status: string };
    if (row.status !== 'queued' && row.status !== 'running') return id;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('run did not finish');
}

const compare = (h: Record<string, string>, a: string, b: string) =>
  app.inject({ method: 'GET', url: `/runs/compare?a=${a}&b=${b}`, headers: h });

test('good -> weak: finds the regressions, with outputs and reasons', async () => {
  const h = await newUser('c1@test.com');
  const w = await world(h);
  const runGood = await finishedRun(h, w.suite, w.good);
  const runWeak = await finishedRun(h, w.suite, w.weak);

  const res = await compare(h, runGood, runWeak);
  assert.equal(res.statusCode, 200);
  const body = res.json();

  assert.equal(body.a.target, 'Good');
  assert.equal(body.b.model, 'weak-model');
  assert.equal(body.a.summary.passRate, 1);
  assert.equal(body.b.summary.passRate, 0.3333);
  assert.equal(body.delta.passRate, -0.6667);
  assert.equal(body.counts.regressions, 2);
  assert.equal(body.counts.improvements, 0);
  assert.equal(body.counts.unchanged, 1);
  assert.equal(body.counts.compared, 3);

  const inputs = body.regressions.map((r: { input: string }) => r.input).sort();
  assert.deepEqual(inputs, ['Capital of France?', 'What is 12 times 12?']);
  const france = body.regressions.find((r: { input: string }) => r.input === 'Capital of France?');
  assert.equal(france.a.passRate, 1);
  assert.equal(france.b.passRate, 0);
  assert.equal(france.a.output, 'Paris');
  assert.equal(france.b.output, 'Lyon');
  assert.match(france.b.reason, /does not contain "Paris"/);
  assert.equal(france.delta, -1);

  // weak target costs 2x per token, same tokens, so cost went up and token count is unchanged
  assert.ok(body.delta.costUsd > 0);
  assert.equal(body.delta.totalTokens, 0);
});

test('weak -> good: the same cases show up as improvements', async () => {
  const h = await newUser('c2@test.com');
  const w = await world(h);
  const runWeak = await finishedRun(h, w.suite, w.weak);
  const runGood = await finishedRun(h, w.suite, w.good);

  const body = (await compare(h, runWeak, runGood)).json();
  assert.equal(body.counts.improvements, 2);
  assert.equal(body.counts.regressions, 0);
  assert.equal(body.delta.passRate, 0.6667);
});

test('works with repeated runs (pass rate per case across attempts)', async () => {
  const h = await newUser('c3@test.com');
  const w = await world(h);
  const runGood = await finishedRun(h, w.suite, w.good, { repeat: 2 });
  const runWeak = await finishedRun(h, w.suite, w.weak, { repeat: 2 });
  const body = (await compare(h, runGood, runWeak)).json();
  assert.equal(body.counts.regressions, 2);
  assert.equal(body.a.summary.total, 6);
});

test('same model twice means no changes', async () => {
  const h = await newUser('c4@test.com');
  const w = await world(h);
  const r1 = await finishedRun(h, w.suite, w.good);
  const r2 = await finishedRun(h, w.suite, w.good);
  const body = (await compare(h, r1, r2)).json();
  assert.equal(body.counts.regressions, 0);
  assert.equal(body.counts.improvements, 0);
  assert.equal(body.counts.unchanged, 3);
  assert.equal(body.delta.passRate, 0);
});

test('rejects same run, different suites, unfinished runs, and other workspaces', async () => {
  const alice = await newUser('alice6@test.com');
  const bob = await newUser('bob6@test.com');
  const w = await world(alice);
  const r1 = await finishedRun(alice, w.suite, w.good);
  const r2 = await finishedRun(alice, w.suite, w.weak);

  assert.equal((await compare(alice, r1, r1)).statusCode, 400);
  assert.equal((await compare(bob, r1, r2)).statusCode, 404);
  assert.equal((await compare(alice, r1, 'does-not-exist')).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: `/runs/compare?a=${r1}&b=${r2}` })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/runs/compare?a=x', headers: alice })).statusCode, 400);

  // a second suite
  const suite2 = (await app.inject({ method: 'POST', url: '/suites', headers: alice, payload: { name: 'other' } })).json().id;
  await app.inject({ method: 'POST', url: `/suites/${suite2}/cases`, headers: alice, payload: { input: 'hi' } });
  const r3 = await finishedRun(alice, suite2, w.good);
  assert.equal((await compare(alice, r1, r3)).json().error, 'different_suites');

  // an unfinished run
  db.prepare("INSERT INTO runs (id, suite_id, target_id, status) VALUES ('unfinished', ?, ?, 'running')").run(w.suite, w.good);
  const res = await compare(alice, r1, 'unfinished');
  assert.equal(res.statusCode, 409);
});
