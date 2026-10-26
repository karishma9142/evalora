import { db } from './db.js';
import { decrypt } from './lib/crypto.js';
import { calcCost } from './lib/cost.js';
import { gradeOutput } from './graders/index.js';
import type { GraderConfig } from './graders/types.js';
import { getProvider, ProviderError } from './providers/index.js';

const RETRY_BASE_MS = 500;
const MAX_RETRIES = 2;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Retry network problems, timeouts, rate limits (429) and server errors (5xx).
// Do NOT retry client errors like a wrong model name or a bad key.
function isRetryable(err: unknown): boolean {
  return err instanceof ProviderError && (err.status === undefined || err.status === 429 || err.status >= 500);
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= MAX_RETRIES || !isRetryable(err)) throw err;
      await sleep(RETRY_BASE_MS * 2 ** attempt); // 0.5s, then 1s
    }
  }
}

// Runs fn over all items, never more than `limit` at the same time
async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

type RunInfo = {
  model: string;
  system_prompt: string | null;
  temperature: number | null;
  max_tokens: number | null;
  input_price_per_m: number | null;
  output_price_per_m: number | null;
  provider: string;
  base_url: string | null;
  encrypted_key: string;
};

type Job = {
  result_id: string;
  input: string;
  expected: string | null;
  grader_config: string;
};

export async function executeRun(runId: string, concurrency = 3): Promise<void> {
  try {
    const run = db
      .prepare(
        `SELECT t.model, t.system_prompt, t.temperature, t.max_tokens,
                t.input_price_per_m, t.output_price_per_m,
                c.provider, c.base_url, c.encrypted_key
         FROM runs r
         JOIN targets t ON t.id = r.target_id
         JOIN credentials c ON c.id = t.credential_id
         WHERE r.id = ?`,
      )
      .get(runId) as RunInfo | undefined;
    if (!run) return;

    db.prepare("UPDATE runs SET status = 'running', started_at = datetime('now') WHERE id = ?").run(runId);

    // The key is decrypted once, in memory, for the life of this run
    const provider = getProvider({
      provider: run.provider,
      baseUrl: run.base_url,
      apiKey: decrypt(run.encrypted_key),
    });

    // Pending results = rows created with the run that have no output and no error yet
    const jobs = db
      .prepare(
        `SELECT res.id AS result_id, c.input, c.expected, c.grader_config
         FROM results res JOIN test_cases c ON c.id = res.test_case_id
         WHERE res.run_id = ? AND res.output IS NULL AND res.error IS NULL
         ORDER BY res.rowid`,
      )
      .all(runId) as Job[];

    const save = db.prepare(
      `UPDATE results SET output = ?, error = ?, input_tokens = ?, output_tokens = ?, latency_ms = ?,
              cost_usd = ?, passed = ?, score = ?, grader_results = ? WHERE id = ?`,
    );

    let abortReason: string | null = null;

    await runPool(jobs, concurrency, async (job) => {
      if (abortReason) return; // a fatal error already happened, skip the rest

      try {
        const gen = await withRetry(() =>
          provider.generate({
            model: run.model,
            system: run.system_prompt,
            prompt: job.input,
            temperature: run.temperature,
            maxTokens: run.max_tokens,
          }),
        );
        const graded = gradeOutput(JSON.parse(job.grader_config) as GraderConfig[], {
          output: gen.text,
          expected: job.expected,
        });
        save.run(
          gen.text,
          null,
          gen.inputTokens,
          gen.outputTokens,
          gen.latencyMs,
          calcCost(gen.inputTokens, gen.outputTokens, run.input_price_per_m, run.output_price_per_m),
          graded.passed === null ? null : graded.passed ? 1 : 0,
          graded.score,
          JSON.stringify(graded.results),
          job.result_id,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        save.run(null, message, null, null, null, null, 0, 0, null, job.result_id);
        // A rejected key will fail every case. Stop instead of burning through the whole suite.
        if (err instanceof ProviderError && (err.status === 401 || err.status === 403)) {
          abortReason = `The provider rejected the API key (HTTP ${err.status}). Check your credential.`;
        }
      }
    });

    if (abortReason) {
      db.prepare("UPDATE runs SET status = 'failed', error = ?, finished_at = datetime('now') WHERE id = ?").run(
        abortReason,
        runId,
      );
    } else {
      db.prepare("UPDATE runs SET status = 'completed', finished_at = datetime('now') WHERE id = ?").run(runId);
    }
  } catch (err) {
    db.prepare("UPDATE runs SET status = 'failed', error = ?, finished_at = datetime('now') WHERE id = ?").run(
      err instanceof Error ? err.message : 'Unknown error',
      runId,
    );
  }
}

// If the server stopped in the middle of a run, that run can never finish. Mark it failed on startup.
export function recoverStaleRuns(): number {
  return db
    .prepare(
      `UPDATE runs SET status = 'failed', error = 'Server restarted while this run was in progress',
              finished_at = datetime('now') WHERE status IN ('queued', 'running')`,
    )
    .run().changes;
}
