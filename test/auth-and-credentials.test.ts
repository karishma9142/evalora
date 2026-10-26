import { test } from 'node:test';
import assert from 'node:assert/strict';

// Set the environment BEFORE importing the app (in-memory DB, throwaway key)
process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = ':memory:';
process.env.ENCRYPTION_KEY = 'ab'.repeat(32);

const { buildApp } = await import('../src/app.js');
const { encrypt, decrypt } = await import('../src/lib/crypto.js');

const app = buildApp();
await app.ready();

async function register(email: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { email, password: 'password123' },
  });
  return res;
}

test('encrypt/decrypt round trip, and ciphertext differs each time', () => {
  const a = encrypt('sk-secret-key-1234');
  const b = encrypt('sk-secret-key-1234');
  assert.notEqual(a, b);
  assert.equal(decrypt(a), 'sk-secret-key-1234');
  assert.ok(!a.includes('sk-secret'));
});

test('register, duplicate email, login, wrong password', async () => {
  const res = await register('a@test.com');
  assert.equal(res.statusCode, 201);
  assert.ok(res.json().token);

  assert.equal((await register('a@test.com')).statusCode, 409);

  const ok = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'a@test.com', password: 'password123' } });
  assert.equal(ok.statusCode, 200);

  const bad = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'a@test.com', password: 'wrongpass1' } });
  assert.equal(bad.statusCode, 401);
});

test('credentials require a token', async () => {
  const res = await app.inject({ method: 'GET', url: '/credentials' });
  assert.equal(res.statusCode, 401);
});

test('credential flow: key is never returned, other users cannot touch it', async () => {
  const alice = (await register('alice@test.com')).json().token as string;
  const bob = (await register('bob@test.com')).json().token as string;
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });

  const created = await app.inject({
    method: 'POST',
    url: '/credentials',
    headers: auth(alice),
    payload: { label: 'My key', provider: 'anthropic', apiKey: 'sk-ant-supersecret-9876' },
  });
  assert.equal(created.statusCode, 201);
  assert.ok(!created.body.includes('supersecret'));
  assert.equal(created.json().keyHint, '••••9876');

  const list = await app.inject({ method: 'GET', url: '/credentials', headers: auth(alice) });
  assert.equal(list.json().length, 1);
  assert.ok(!list.body.includes('supersecret'));
  assert.ok(!list.body.includes('encrypted'));

  // Bob sees nothing and cannot delete Alice's key
  const bobList = await app.inject({ method: 'GET', url: '/credentials', headers: auth(bob) });
  assert.equal(bobList.json().length, 0);
  const id = created.json().id as string;
  const bobDel = await app.inject({ method: 'DELETE', url: `/credentials/${id}`, headers: auth(bob) });
  assert.equal(bobDel.statusCode, 404);

  const del = await app.inject({ method: 'DELETE', url: `/credentials/${id}`, headers: auth(alice) });
  assert.equal(del.statusCode, 204);
});

test('openai-compatible requires baseUrl; bad input gives 400', async () => {
  const token = (await register('c@test.com')).json().token as string;
  const res = await app.inject({
    method: 'POST',
    url: '/credentials',
    headers: { authorization: `Bearer ${token}` },
    payload: { label: 'x', provider: 'openai-compatible', apiKey: 'abcdefgh1234' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'validation_error');
});
