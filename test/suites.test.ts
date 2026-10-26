import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = ':memory:';
process.env.ENCRYPTION_KEY = 'ef'.repeat(32);

const { buildApp } = await import('../src/app.js');
const { parseCsv } = await import('../src/lib/csv.js');

const app = buildApp();
await app.ready();

async function newUser(email: string) {
  const res = await app.inject({ method: 'POST', url: '/auth/register', payload: { email, password: 'password123' } });
  return { authorization: `Bearer ${res.json().token}` };
}
async function newSuite(h: Record<string, string>, name = 'My suite') {
  const res = await app.inject({ method: 'POST', url: '/suites', headers: h, payload: { name } });
  return res.json().id as string;
}
const csv = (h: Record<string, string>, id: string, body: string) =>
  app.inject({ method: 'POST', url: `/suites/${id}/import-csv`, headers: { ...h, 'content-type': 'text/csv' }, payload: body });

test('CSV parser: quotes, commas, newlines in quotes, CRLF, BOM, blank lines', () => {
  assert.deepEqual(parseCsv('a,b\n1,2\n'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv('"hello, world","say ""hi"""\n'), [['hello, world', 'say "hi"']]);
  assert.deepEqual(parseCsv('"line1\nline2",x'), [['line1\nline2', 'x']]);
  assert.deepEqual(parseCsv('\uFEFFinput\nq'), [['input'], ['q']]);
  assert.deepEqual(parseCsv('a,,c'), [['a', '', 'c']]);
  assert.throws(() => parseCsv('"never closed'));
});

test('suites require auth', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/suites' })).statusCode, 401);
});

test('create suite, add one case and many cases, list with counts', async () => {
  const h = await newUser('s1@test.com');
  const id = await newSuite(h, 'Geography');

  const one = await app.inject({
    method: 'POST', url: `/suites/${id}/cases`, headers: h,
    payload: { input: 'Capital of France?', expected: 'Paris', tags: ['geo'], graders: [{ type: 'contains' }] },
  });
  assert.equal(one.statusCode, 201);
  assert.equal(one.json().added, 1);

  const many = await app.inject({
    method: 'POST', url: `/suites/${id}/cases`, headers: h,
    payload: { cases: [{ input: 'a' }, { input: 'b' }, { input: 'c', graders: [{ type: 'json_valid' }] }] },
  });
  assert.equal(many.json().added, 3);

  const list = await app.inject({ method: 'GET', url: `/suites/${id}/cases?limit=2`, headers: h });
  assert.equal(list.json().total, 4);
  assert.equal(list.json().cases.length, 2);
  assert.deepEqual(list.json().cases[0].tags, ['geo']);
  assert.equal(list.json().cases[0].graders[0].type, 'contains');

  const suites = await app.inject({ method: 'GET', url: '/suites', headers: h });
  assert.equal(suites.json()[0].caseCount, 4);
});

test('validation: exact_match needs expected, bad regex is rejected, unknown grader rejected', async () => {
  const h = await newUser('s2@test.com');
  const id = await newSuite(h);
  const post = (payload: unknown) => app.inject({ method: 'POST', url: `/suites/${id}/cases`, headers: h, payload: payload as object });

  assert.equal((await post({ input: 'q', graders: [{ type: 'exact_match' }] })).statusCode, 400);
  assert.equal((await post({ input: 'q', graders: [{ type: 'contains' }] })).statusCode, 400);
  assert.equal((await post({ input: 'q', graders: [{ type: 'contains', value: 'x' }] })).statusCode, 201);
  assert.equal((await post({ input: 'q', graders: [{ type: 'regex', pattern: '([' }] })).statusCode, 400);
  assert.equal((await post({ input: 'q', graders: [{ type: 'regex', pattern: '^\\d+$' }] })).statusCode, 201);
  assert.equal((await post({ input: 'q', graders: [{ type: 'magic' }] })).statusCode, 400);
  assert.equal((await post({ input: '' })).statusCode, 400);
  assert.equal((await post({ cases: [{ input: 'ok' }, { input: '' }] })).statusCode, 400); // bulk is all or nothing

  const count = await app.inject({ method: 'GET', url: `/suites/${id}`, headers: h });
  assert.equal(count.json().caseCount, 2); // only the two valid single adds
});

test('CSV import: quoted commas, tags, grader column', async () => {
  const h = await newUser('s3@test.com');
  const id = await newSuite(h);
  const body = [
    'input,expected,tags,grader',
    'What is the capital of France?,Paris,geography;easy,contains',
    '"Name the capital of Japan, in one word.",Tokyo,geography,contains',
    'Reply with valid JSON,,format,json_valid',
    '',
    '"Multi',
    'line question",,,',
  ].join('\n');
  const res = await csv(h, id, body);
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().imported, 4);

  const cases = (await app.inject({ method: 'GET', url: `/suites/${id}/cases`, headers: h })).json().cases;
  assert.equal(cases[1].input, 'Name the capital of Japan, in one word.');
  assert.deepEqual(cases[0].tags, ['geography', 'easy']);
  assert.equal(cases[2].graders[0].type, 'json_valid');
  assert.equal(cases[3].input, 'Multi\nline question');
});

test('CSV import is all-or-nothing and reports row numbers', async () => {
  const h = await newUser('s4@test.com');
  const id = await newSuite(h);
  const body = ['input,expected,grader', 'ok question,yes,contains', 'bad one,,exact_match', 'another,,sparkle'].join('\n');
  const res = await csv(h, id, body);
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().imported, 0);
  const rows = res.json().errors.map((e: { row: number }) => e.row);
  assert.deepEqual(rows, [3, 4]);
  assert.equal((await app.inject({ method: 'GET', url: `/suites/${id}`, headers: h })).json().caseCount, 0);

  assert.equal((await csv(h, id, 'question\nhello')).statusCode, 400); // no "input" column
  assert.equal((await csv(h, id, 'input')).statusCode, 400); // header only
  const wrongType = await app.inject({ method: 'POST', url: `/suites/${id}/import-csv`, headers: h, payload: { x: 1 } });
  assert.equal(wrongType.statusCode, 415);
});

test('tenant isolation on suites and cases', async () => {
  const alice = await newUser('alice4@test.com');
  const bob = await newUser('bob4@test.com');
  const id = await newSuite(alice);
  await app.inject({ method: 'POST', url: `/suites/${id}/cases`, headers: alice, payload: { input: 'secret question' } });

  for (const [method, url] of [
    ['GET', `/suites/${id}`], ['GET', `/suites/${id}/cases`], ['DELETE', `/suites/${id}`],
  ] as const) {
    assert.equal((await app.inject({ method, url, headers: bob })).statusCode, 404, `${method} ${url}`);
  }
  assert.equal((await app.inject({ method: 'POST', url: `/suites/${id}/cases`, headers: bob, payload: { input: 'x' } })).statusCode, 404);
  assert.equal((await csv(bob, id, 'input\nx')).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: '/suites', headers: bob })).json().length, 0);
});

test('delete a case, then delete the suite (cases go with it)', async () => {
  const h = await newUser('s5@test.com');
  const id = await newSuite(h);
  await app.inject({ method: 'POST', url: `/suites/${id}/cases`, headers: h, payload: { cases: [{ input: 'a' }, { input: 'b' }] } });
  const cases = (await app.inject({ method: 'GET', url: `/suites/${id}/cases`, headers: h })).json().cases;

  assert.equal((await app.inject({ method: 'DELETE', url: `/suites/${id}/cases/${cases[0].id}`, headers: h })).statusCode, 204);
  assert.equal((await app.inject({ method: 'GET', url: `/suites/${id}`, headers: h })).json().caseCount, 1);

  assert.equal((await app.inject({ method: 'DELETE', url: `/suites/${id}`, headers: h })).statusCode, 204);
  assert.equal((await app.inject({ method: 'GET', url: `/suites/${id}`, headers: h })).statusCode, 404);
});
