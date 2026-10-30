import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = ':memory:';
process.env.ENCRYPTION_KEY = '5c'.repeat(32);

const { buildApp } = await import('../src/app.js');
const { db } = await import('../src/db.js');
const { describeStorage } = await import('../src/diagnostics.js');

const app = buildApp();
await app.ready();

test('startup diagnostics report what is in the database and flag undecryptable keys', async () => {
  const reg = (await app.inject({ method: 'POST', url: '/auth/register', payload: { email: 'd@test.com', password: 'password123' } })).json();
  await app.inject({
    method: 'POST', url: '/credentials', headers: { authorization: `Bearer ${reg.token}` },
    payload: { label: 'ok', provider: 'anthropic', apiKey: 'sk-ant-valid-key-1234' },
  });

  const logs: string[] = []; const warns: string[] = [];
  const clean = describeStorage((m) => logs.push(m), (m) => warns.push(m));
  assert.equal(clean.users, 1);
  assert.equal(clean.credentials, 1);
  assert.equal(clean.undecryptable, 0);
  assert.match(logs[0], /Database: .*users 1, credentials 1/);
  assert.ok(warns.some((w) => /in-memory/.test(w))); // this test database is :memory:
  assert.ok(!warns.some((w) => /cannot be decrypted/.test(w)));

  // a key saved under a different ENCRYPTION_KEY (the "I lost my keys" situation)
  db.prepare("INSERT INTO credentials (id, workspace_id, label, provider, encrypted_key, key_last4) VALUES (?, ?, 'old', 'anthropic', 'AAAA.BBBB.CCCC', '1234')")
    .run(randomUUID(), reg.workspaceId);
  const warns2: string[] = [];
  const broken = describeStorage(() => {}, (m) => warns2.push(m));
  assert.equal(broken.undecryptable, 1);
  assert.ok(warns2.some((w) => /1 of 2 stored API keys cannot be decrypted.*ENCRYPTION_KEY/.test(w)));
});
