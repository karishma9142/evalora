import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = ':memory:';
process.env.ENCRYPTION_KEY = '12'.repeat(32);

const { buildApp } = await import('../src/app.js');
const { db } = await import('../src/db.js');
const { gradeOutput, runGrader } = await import('../src/graders/index.js');
const { recoverStaleRuns } = await import('../src/runner.js');

// ---------- fake AI server ----------
let flakyCalls = 0;
const fake = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const send = (status: number, obj: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.headers.authorization !== 'Bearer good-key-12345') return send(401, { error: 'bad key' });

    const body = JSON.parse(raw);
    const prompt: string = body.messages[body.messages.length - 1].content;
    if (prompt.includes('flaky') && flakyCalls++ === 0) return send(429, { error: 'slow down' });

    const answer = prompt.includes('France')
      ? 'The capital of France is Paris.'
      : prompt.includes('Japan')
        ? 'Osaka' // deliberately wrong
        : prompt.includes('12 times')
          ? '144'
          : prompt.includes('JSON')
            ? '```json\n{"name":"x"}\n```'
            : 'ok';
    send(200, { choices: [{ message: { content: answer } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  });
});
await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
const fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`;
after(() => fake.close());

const app = buildApp();
await app.ready();

// ---------- helpers ----------
async function newUser(email: string) {
  const res = await app.inject({ method: 'POST', url: '/auth/register', payload: { email, password: 'password123' } });
  return { authorization: `Bearer ${res.json().token}` };
}

async function setup(h: Record<string, string>, opts: { key?: string; cases?: object[] } = {}) {
  const cred = await app.inject({
    method: 'POST', url: '/credentials', headers: h,
    payload: { label: 'fake', provider: 'openai-compatible', baseUrl: fakeUrl, apiKey: opts.key ?? 'good-key-12345' },
  });
  const target = await app.inject({
    method: 'POST', url: '/targets', headers: h,
    payload: { name: 't', credentialId: cred.json().id, model: 'fake-1', inputPricePerM: 1, outputPricePerM: 2 },
  });
  const suite = await app.inject({ method: 'POST', url: '/suites', headers: h, payload: { name: 's' } });
  const cases = opts.cases ?? [
    { input: 'Capital of France?', expected: 'Paris', graders: [{ type: 'contains' }] },
    { input: 'Capital of Japan?', expected: 'Tokyo', graders: [{ type: 'contains' }] },
    { input: 'What is 12 times 12?', expected: '144', graders: [{ type: 'exact_match' }] },
    { input: 'Reply with JSON', graders: [{ type: 'json_valid' }] },
  ];
  await app.inject({ method: 'POST', url: `/suites/${suite.json().id}/cases`, headers: h, payload: { cases } });
  return { targetId: target.json().id as string, suiteId: suite.json().id as string };
}

// Poll the database directly (not HTTP) so we don't hit the API rate limit
async function waitDone(runId: string) {
  for (let i = 0; i < 150; i++) {
    const row = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string };
    if (row.status === 'completed' || row.status === 'failed') return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('run did not finish');
}

const startRun = (h: Record<string, string>, payload: object) =>
  app.inject({ method: 'POST', url: '/runs', headers: h, payload });

// ---------- grader unit tests ----------
test('graders: exact_match, contains, regex, json_valid, llm_judge, combining', () => {
  const ctx = (output: string, expected: string | null = null) => ({ output, expected });

  assert.equal(runGrader({ type: 'exact_match' }, ctx('  paris \n', 'Paris')).passed, true);
  assert.equal(runGrader({ type: 'exact_match', caseSensitive: true }, ctx('paris', 'Paris')).passed, false);
  assert.equal(runGrader({ type: 'exact_match' }, ctx('Paris.', 'Paris')).passed, false);

  assert.equal(runGrader({ type: 'contains' }, ctx('It is PARIS.', 'Paris')).passed, true);
  assert.equal(runGrader({ type: 'contains', value: 'rome' }, ctx('Paris', 'Paris')).passed, false);
  assert.equal(runGrader({ type: 'contains', caseSensitive: true }, ctx('PARIS', 'Paris')).passed, false);

  assert.equal(runGrader({ type: 'regex', pattern: '^\\d+$' }, ctx('144')).passed, true);
  assert.equal(runGrader({ type: 'regex', pattern: '^\\d+$' }, ctx('abc')).passed, false);

  assert.equal(runGrader({ type: 'json_valid' }, ctx('{"a":1}')).passed, true);
  assert.equal(runGrader({ type: 'json_valid' }, ctx('```json\n{"a":1}\n```')).passed, true);
  assert.equal(runGrader({ type: 'json_valid' }, ctx('{oops')).passed, false);

  assert.equal(runGrader({ type: 'llm_judge', rubric: 'x' }, ctx('hi')).skipped, true);

  const both = gradeOutput([{ type: 'contains', value: 'a' }, { type: 'contains', value: 'zzz' }], ctx('abc'));
  assert.equal(both.passed, false);
  assert.equal(both.score, 0.5);

  const skippedOnly = gradeOutput([{ type: 'llm_judge', rubric: 'x' }], ctx('abc'));
  assert.equal(skippedOnly.passed, null);
  assert.equal(gradeOutput([], ctx('abc')).passed, null);
});

// ---------- full run tests ----------
test('full run: grades each case, summarizes pass rate, tokens, cost', async () => {
  const h = await newUser('r1@test.com');
  const { targetId, suiteId } = await setup(h);

  const started = await startRun(h, { suiteId, targetId });
  assert.equal(started.statusCode, 202);
  assert.equal(started.json().total, 4);
  const runId = started.json().id as string;
  await waitDone(runId);

  const run = (await app.inject({ method: 'GET', url: `/runs/${runId}`, headers: h })).json();
  assert.equal(run.status, 'completed');
  assert.equal(run.summary.total, 4);
  assert.equal(run.summary.passed, 3);
  assert.equal(run.summary.failed, 1);
  assert.equal(run.summary.errors, 0);
  assert.equal(run.summary.passRate, 0.75);
  assert.equal(run.summary.inputTokens, 40);
  assert.equal(run.summary.outputTokens, 20);
  assert.equal(run.summary.costUsd, (40 * 1 + 20 * 2) / 1e6);
  assert.ok(run.summary.avgLatencyMs >= 0);

  const failed = (await app.inject({ method: 'GET', url: `/runs/${runId}/results?status=failed`, headers: h })).json();
  assert.equal(failed.length, 1);
  assert.equal(failed[0].input, 'Capital of Japan?');
  assert.equal(failed[0].output, 'Osaka');
  assert.equal(failed[0].passed, false);
  assert.match(failed[0].graderResults[0].reason, /does not contain "Tokyo"/);

  const passed = (await app.inject({ method: 'GET', url: `/runs/${runId}/results?status=passed`, headers: h })).json();
  assert.equal(passed.length, 3);

  const list = (await app.inject({ method: 'GET', url: `/runs?suiteId=${suiteId}`, headers: h })).json();
  assert.equal(list.length, 1);
});

test('a rate-limited call (429) is retried and then succeeds', async () => {
  const h = await newUser('r2@test.com');
  const { targetId, suiteId } = await setup(h, {
    cases: [{ input: 'flaky question', expected: 'ok', graders: [{ type: 'contains' }] }],
  });
  const runId = (await startRun(h, { suiteId, targetId })).json().id as string;
  await waitDone(runId);
  const run = (await app.inject({ method: 'GET', url: `/runs/${runId}`, headers: h })).json();
  assert.equal(run.status, 'completed');
  assert.equal(run.summary.errors, 0);
  assert.equal(run.summary.passed, 1);
  assert.ok(flakyCalls >= 2); // first call got 429, the retry went through
});

test('a rejected API key stops the run early with a clear message', async () => {
  const h = await newUser('r3@test.com');
  const { targetId, suiteId } = await setup(h, { key: 'wrong-key-99999' });
  const runId = (await startRun(h, { suiteId, targetId, concurrency: 1 })).json().id as string;
  await waitDone(runId);

  const run = (await app.inject({ method: 'GET', url: `/runs/${runId}`, headers: h })).json();
  assert.equal(run.status, 'failed');
  assert.match(run.error, /401/);
  assert.equal(run.summary.errors, 1);
  assert.equal(run.summary.pending, 3); // the rest were skipped, not wasted
  assert.ok(!JSON.stringify(run).includes('wrong-key-99999'));
});

test('repeat runs each case several times', async () => {
  const h = await newUser('r4@test.com');
  const { targetId, suiteId } = await setup(h);
  const started = await startRun(h, { suiteId, targetId, repeat: 3 });
  assert.equal(started.json().total, 12);
  await waitDone(started.json().id);
  const run = (await app.inject({ method: 'GET', url: `/runs/${started.json().id}`, headers: h })).json();
  assert.equal(run.summary.total, 12);
  assert.equal(run.summary.completed, 12);
});

test('cases without graders are reported as ungraded, not failed', async () => {
  const h = await newUser('r5@test.com');
  const { targetId, suiteId } = await setup(h, { cases: [{ input: 'just a question' }] });
  const runId = (await startRun(h, { suiteId, targetId })).json().id as string;
  await waitDone(runId);
  const run = (await app.inject({ method: 'GET', url: `/runs/${runId}`, headers: h })).json();
  assert.equal(run.summary.ungraded, 1);
  assert.equal(run.summary.passRate, null);
});

test('validation and tenant isolation', async () => {
  const alice = await newUser('alice5@test.com');
  const bob = await newUser('bob5@test.com');
  const { targetId, suiteId } = await setup(alice);

  const emptySuite = (await app.inject({ method: 'POST', url: '/suites', headers: alice, payload: { name: 'empty' } })).json().id;
  assert.equal((await startRun(alice, { suiteId: emptySuite, targetId })).statusCode, 400);
  assert.equal((await startRun(alice, { suiteId, targetId, repeat: 99 })).statusCode, 400);

  assert.equal((await startRun(bob, { suiteId, targetId })).statusCode, 404);

  const runId = (await startRun(alice, { suiteId, targetId })).json().id as string;
  await waitDone(runId);
  assert.equal((await app.inject({ method: 'GET', url: `/runs/${runId}`, headers: bob })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: `/runs/${runId}/results`, headers: bob })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: '/runs', headers: bob })).json().length, 0);
  assert.equal((await app.inject({ method: 'GET', url: '/runs' })).statusCode, 401);
});

test('runs interrupted by a restart are marked failed on startup', async () => {
  const h = await newUser('r6@test.com');
  const { targetId, suiteId } = await setup(h);
  db.prepare("INSERT INTO runs (id, suite_id, target_id, status) VALUES ('stale-run', ?, ?, 'running')").run(suiteId, targetId);
  assert.ok(recoverStaleRuns() >= 1);
  const row = db.prepare("SELECT status, error FROM runs WHERE id = 'stale-run'").get() as { status: string; error: string };
  assert.equal(row.status, 'failed');
  assert.match(row.error, /restarted/);
});
