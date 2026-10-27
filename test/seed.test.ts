import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = ':memory:';
process.env.ENCRYPTION_KEY = '78'.repeat(32);

const { buildApp } = await import('../src/app.js');
const { seedDemo, DEMO_EMAIL, DEMO_PASSWORD } = await import('../src/seed.js');

const app = buildApp();
await app.ready();
const silent = () => {};

test('seeding creates a demo account whose dashboard data is consistent', async () => {
  assert.equal(await seedDemo(silent), true);

  const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: DEMO_EMAIL, password: DEMO_PASSWORD } });
  assert.equal(login.statusCode, 200);
  const h = { authorization: `Bearer ${login.json().token}` };

  const runs = (await app.inject({ method: 'GET', url: '/runs', headers: h })).json();
  assert.equal(runs.length, 5);
  // newest first: the fixed v2.1, the risky v2, then v1 improving over time
  assert.deepEqual(runs.map((r: { summary: { passRate: number } }) => r.summary.passRate), [0.9167, 0.5833, 0.9167, 0.75, 0.5833]);
  assert.ok(runs.every((r: { status: string }) => r.status === 'completed'));
  assert.ok(runs[0].summary.costUsd > 0);

  // the risky "short answers" prompt regressed 4 cases compared with the last good v1 run
  const compare = (await app.inject({ method: 'GET', url: `/runs/compare?a=${runs[2].id}&b=${runs[1].id}`, headers: h })).json();
  assert.equal(compare.counts.regressions, 4);
  assert.equal(compare.counts.improvements, 0);
  assert.equal(compare.delta.passRate, -0.3333);

  // the fix removed those regressions
  const fixed = (await app.inject({ method: 'GET', url: `/runs/compare?a=${runs[2].id}&b=${runs[0].id}`, headers: h })).json();
  assert.equal(fixed.counts.regressions, 1);
  assert.equal(fixed.counts.improvements, 1);

  const suites = (await app.inject({ method: 'GET', url: '/suites', headers: h })).json();
  assert.equal(suites[0].caseCount, 12);
  assert.match(suites[0].name, /sample data/);
});

test('seeding twice does nothing the second time', async () => {
  assert.equal(await seedDemo(silent), false);
});
