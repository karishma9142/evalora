import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

mkdirSync(dirname(config.DATABASE_PATH), { recursive: true });

export const db = new Database(config.DATABASE_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// The whole schema lives here. It runs on every start and only creates what is missing.
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS workspaces (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The user's own API key for one provider. Stored encrypted, never returned by the API.
CREATE TABLE IF NOT EXISTS credentials (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,
  provider      TEXT NOT NULL,          -- 'anthropic' | 'openai-compatible'
  base_url      TEXT,                   -- only for openai-compatible
  encrypted_key TEXT NOT NULL,
  key_last4     TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The AI being tested: credential + model + prompt + params
CREATE TABLE IF NOT EXISTS targets (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  credential_id       TEXT NOT NULL REFERENCES credentials(id),
  name                TEXT NOT NULL,
  model               TEXT NOT NULL,
  system_prompt       TEXT,
  temperature         REAL,
  max_tokens          INTEGER,
  input_price_per_m   REAL,             -- $ per 1M input tokens, entered by the user
  output_price_per_m  REAL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS suites (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS test_cases (
  id            TEXT PRIMARY KEY,
  suite_id      TEXT NOT NULL REFERENCES suites(id) ON DELETE CASCADE,
  input         TEXT NOT NULL,
  expected      TEXT,
  context       TEXT,
  tags          TEXT NOT NULL DEFAULT '[]',   -- JSON array
  grader_config TEXT NOT NULL DEFAULT '[]',   -- JSON array of graders
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS runs (
  id              TEXT PRIMARY KEY,
  suite_id        TEXT NOT NULL REFERENCES suites(id) ON DELETE CASCADE,
  target_id       TEXT NOT NULL REFERENCES targets(id),
  judge_target_id TEXT REFERENCES targets(id),  -- optional: the AI that grades
  status          TEXT NOT NULL DEFAULT 'queued', -- queued | running | completed | failed
  repeat          INTEGER NOT NULL DEFAULT 1,
  started_at      TEXT,
  finished_at     TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS results (
  id             TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  test_case_id   TEXT NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
  attempt        INTEGER NOT NULL DEFAULT 1,
  output         TEXT,
  error          TEXT,
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  latency_ms     INTEGER,
  cost_usd       REAL,
  passed         INTEGER,                -- 0 or 1
  score          REAL,                   -- 0 to 1
  grader_results TEXT,                   -- JSON
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_results_run  ON results(run_id);
CREATE INDEX IF NOT EXISTS idx_results_case ON results(test_case_id);
CREATE INDEX IF NOT EXISTS idx_cases_suite  ON test_cases(suite_id);
`);

// Small migrations: add columns that older databases don't have yet
const runColumns = db.prepare('PRAGMA table_info(runs)').all() as { name: string }[];
if (!runColumns.some((c) => c.name === 'error')) {
  db.exec('ALTER TABLE runs ADD COLUMN error TEXT');
}
