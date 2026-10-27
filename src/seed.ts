import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { db } from './db.js';
import { encrypt, hashPassword } from './lib/crypto.js';

// Sample data for screenshots and demos. It is SYNTHETIC: no AI was called and the
// answers are written by hand. Everything is labelled "sample" so it can never be
// mistaken for real results.

export const DEMO_EMAIL = 'demo@evalboard.dev';
export const DEMO_PASSWORD = 'demo-password-123';

// [question, expected text, good answer, bad answer, tag]
const CASES: [string, string, string, string, string][] = [
  ['How do I reset my password?', 'Forgot password', "Use the 'Forgot password' link on the sign-in page.", 'Please contact an administrator.', 'account'],
  ['What are your support hours?', '9am', 'Support is open 9am to 6pm, Monday to Friday.', 'We are available at all times.', 'general'],
  ['How do I cancel my subscription?', 'Settings', 'Go to Settings > Billing and choose Cancel plan.', 'Subscriptions cannot be cancelled.', 'billing'],
  ['Do you offer refunds?', '30 days', 'Yes, within 30 days of purchase.', 'Refunds are not available.', 'billing'],
  ['How do I change my email address?', 'Profile', 'Open Profile and edit your email address.', 'Emails cannot be changed.', 'account'],
  ['Is my data encrypted?', 'encrypted', 'Yes, data is encrypted in transit and at rest.', 'We take security seriously.', 'security'],
  ['Can I export my data?', 'CSV', 'Yes, export everything as CSV from Settings > Data.', 'Exporting is not supported.', 'data'],
  ['How do I add a teammate?', 'Invite', 'Use Invite member under Team settings.', 'Share your password with them.', 'team'],
  ['What payment methods do you accept?', 'credit card', 'We accept every major credit card and PayPal.', 'Cash only.', 'billing'],
  ['Do you have a mobile app?', 'iOS', 'Yes, apps for iOS and Android are available.', 'No, only a website.', 'general'],
  ['How do I delete my account?', 'Settings', 'Settings > Account > Delete account. This cannot be undone.', 'Just stop using it.', 'account'],
  ['Where can I see my invoices?', 'Billing', 'Open Billing to see and download invoices.', 'Invoices are sent by post.', 'billing'],
];

// Which cases fail in each historical run (indexes into CASES): a story of prompt improvements,
// a risky "shorter answers" prompt that causes regressions, and a fixed version.
const RUNS = [
  { target: 0, daysAgo: 10, failing: [1, 3, 5, 8, 9], latency: 1100 },
  { target: 0, daysAgo: 7, failing: [3, 8, 9], latency: 1000 },
  { target: 0, daysAgo: 4, failing: [3], latency: 950 },
  { target: 1, daysAgo: 2, failing: [2, 3, 6, 7, 10], latency: 620 },
  { target: 2, daysAgo: 1, failing: [9], latency: 700 },
];

const TARGETS = [
  { name: 'Support bot v1', prompt: 'You are a helpful customer support assistant for a SaaS product. Answer briefly and accurately.' },
  { name: 'Support bot v2 (short answers)', prompt: 'You are a support assistant. Answer in as few words as possible.' },
  { name: 'Support bot v2.1', prompt: 'You are a support assistant. Be brief, but always mention the exact menu or page name the user needs.' },
];

const sqlTime = (daysAgo: number, minutes = 0) =>
  new Date(Date.now() - daysAgo * 86_400_000 + minutes * 60_000).toISOString().slice(0, 19).replace('T', ' ');

export async function seedDemo(log: (s: string) => void = console.log): Promise<boolean> {
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(DEMO_EMAIL)) {
    log('Demo data already exists. Nothing to do.');
    return false;
  }

  const userId = randomUUID();
  const workspaceId = randomUUID();
  const credentialId = randomUUID();
  const suiteId = randomUUID();
  const targetIds = TARGETS.map(() => randomUUID());
  const caseIds = CASES.map(() => randomUUID());
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  // Small repeatable pseudo-random numbers, so the sample data is identical every time
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

  db.transaction(() => {
    db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)').run(userId, DEMO_EMAIL, passwordHash);
    db.prepare('INSERT INTO workspaces (id, name, owner_id) VALUES (?, ?, ?)').run(workspaceId, 'Demo workspace', userId);
    db.prepare(
      `INSERT INTO credentials (id, workspace_id, label, provider, base_url, encrypted_key, key_last4)
       VALUES (?, ?, ?, 'openai-compatible', 'https://api.example.com/v1', ?, ?)`,
    ).run(credentialId, workspaceId, 'Sample credential (not a real key)', encrypt('demo-not-a-real-key'), '-key');

    TARGETS.forEach((t, i) => {
      db.prepare(
        `INSERT INTO targets (id, workspace_id, credential_id, name, model, system_prompt, input_price_per_m, output_price_per_m)
         VALUES (?, ?, ?, ?, 'sample-model-1', ?, 3, 15)`,
      ).run(targetIds[i], workspaceId, credentialId, t.name, t.prompt);
    });

    db.prepare('INSERT INTO suites (id, workspace_id, name, description) VALUES (?, ?, ?, ?)').run(
      suiteId, workspaceId, 'Customer support (sample data)', 'Synthetic demo data. No AI was called to produce these results.',
    );
    CASES.forEach(([input, expected, , , tag], i) => {
      db.prepare(
        `INSERT INTO test_cases (id, suite_id, input, expected, tags, grader_config) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(caseIds[i], suiteId, input, expected, JSON.stringify([tag]), JSON.stringify([{ type: 'contains' }]));
    });

    const insertRun = db.prepare(
      `INSERT INTO runs (id, suite_id, target_id, status, repeat, started_at, finished_at, created_at)
       VALUES (?, ?, ?, 'completed', 1, ?, ?, ?)`,
    );
    const insertResult = db.prepare(
      `INSERT INTO results (id, run_id, test_case_id, attempt, output, input_tokens, output_tokens, latency_ms,
                            cost_usd, passed, score, grader_results, created_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const run of RUNS) {
      const runId = randomUUID();
      const start = sqlTime(run.daysAgo);
      insertRun.run(runId, suiteId, targetIds[run.target], start, sqlTime(run.daysAgo, 1), start);
      CASES.forEach(([, expected, good, bad], i) => {
        const failed = run.failing.includes(i);
        const output = failed ? bad : good;
        const inTokens = 60 + Math.floor(rand() * 20);
        const outTokens = Math.max(6, Math.round(output.length / 4) + Math.floor(rand() * 6));
        insertResult.run(
          randomUUID(), runId, caseIds[i], output, inTokens, outTokens,
          Math.round(run.latency * (0.7 + rand() * 0.6)),
          (inTokens * 3 + outTokens * 15) / 1_000_000,
          failed ? 0 : 1, failed ? 0 : 1,
          JSON.stringify([{ type: 'contains', passed: !failed, score: failed ? 0 : 1, reason: failed ? `Output does not contain "${expected}"` : `Output contains "${expected}"` }]),
          start,
        );
      });
    }
  })();

  log('Sample data created (synthetic, no AI was called).');
  log(`  Sign in with  ${DEMO_EMAIL}  /  ${DEMO_PASSWORD}`);
  return true;
}

// Run only when executed directly: `npm run seed`
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  seedDemo().then(() => process.exit(0));
}
