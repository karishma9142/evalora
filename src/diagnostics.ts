import { resolve } from 'node:path';
import { config } from './config.js';
import { db } from './db.js';
import { decrypt } from './lib/crypto.js';

const count = (table: 'users' | 'credentials' | 'suites' | 'runs') =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

// Prints which database file is in use and what is in it, and warns if the stored API keys
// cannot be decrypted with the current ENCRYPTION_KEY. Called when the server starts, so
// "my data is gone" is explained immediately: wrong folder, wrong file, or a changed key.
export function describeStorage(
  log: (msg: string) => void = console.log,
  warn: (msg: string) => void = console.warn,
) {
  const counts = { users: count('users'), credentials: count('credentials'), suites: count('suites'), runs: count('runs') };
  log(
    `Database: ${resolve(config.DATABASE_PATH)}  (users ${counts.users}, credentials ${counts.credentials}, suites ${counts.suites}, runs ${counts.runs})`,
  );
  if (config.DATABASE_PATH === ':memory:') {
    warn('WARNING: this is an in-memory database. Everything is lost when the server stops.');
  }

  const rows = db.prepare('SELECT encrypted_key FROM credentials LIMIT 200').all() as { encrypted_key: string }[];
  const undecryptable = rows.filter((r) => {
    try { decrypt(r.encrypted_key); return false; } catch { return true; }
  }).length;
  if (undecryptable > 0) {
    warn(
      `WARNING: ${undecryptable} of ${rows.length} stored API keys cannot be decrypted. ` +
        'ENCRYPTION_KEY in .env is not the key they were saved with. Restore the original key, or add those credentials again.',
    );
  }
  return { ...counts, undecryptable };
}
