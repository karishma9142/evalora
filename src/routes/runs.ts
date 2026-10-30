import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db } from '../db.js';
import { requireAuth } from '../lib/auth.js';
import { executeRun } from '../runner.js';

const MAX_JOBS_PER_RUN = 5000;

type RunRow = {
  id: string;
  suite_id: string;
  target_id: string;
  status: string;
  repeat: number;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
};

type ResultSummaryRow = {
  passed: number | null;
  error: string | null;
  output: string | null;
  latency_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
};

const round = (n: number, digits = 4) => Math.round(n * 10 ** digits) / 10 ** digits;

export function summarize(runId: string) {
  const rows = db
    .prepare('SELECT passed, error, output, latency_ms, input_tokens, output_tokens, cost_usd FROM results WHERE run_id = ?')
    .all(runId) as ResultSummaryRow[];

  const finished = rows.filter((r) => r.output !== null || r.error !== null);
  const graded = finished.filter((r) => r.passed !== null); // errors count as graded failures
  const passed = graded.filter((r) => r.passed === 1).length;
  const latencies = finished.filter((r) => r.latency_ms !== null).map((r) => r.latency_ms as number).sort((a, b) => a - b);
  const costs = finished.filter((r) => r.cost_usd !== null);

  return {
    total: rows.length,
    completed: finished.length,
    pending: rows.length - finished.length,
    passed,
    failed: graded.filter((r) => r.passed === 0 && r.error === null).length,
    errors: finished.filter((r) => r.error !== null).length,
    ungraded: finished.length - graded.length,
    passRate: graded.length ? round(passed / graded.length) : null,
    avgLatencyMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
    p95LatencyMs: latencies.length ? latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1)] : null,
    inputTokens: finished.reduce((sum, r) => sum + (r.input_tokens ?? 0), 0),
    outputTokens: finished.reduce((sum, r) => sum + (r.output_tokens ?? 0), 0),
    costUsd: costs.length ? costs.reduce((sum, r) => sum + (r.cost_usd as number), 0) : null,
  };
}

const runPublic = (r: RunRow) => ({
  id: r.id,
  suiteId: r.suite_id,
  targetId: r.target_id,
  status: r.status,
  repeat: r.repeat,
  error: r.error,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  createdAt: r.created_at,
  summary: summarize(r.id),
});

// A run belongs to a workspace through its suite
function findRun(id: string, workspaceId: string): RunRow | undefined {
  return db
    .prepare('SELECT r.* FROM runs r JOIN suites s ON s.id = r.suite_id WHERE r.id = ? AND s.workspace_id = ?')
    .get(id, workspaceId) as RunRow | undefined;
}

const createLimit = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

export async function runRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  // Start a run: send every case in the suite to the target, grade it, save everything.
  // Returns immediately (202). The run continues in the background. Poll GET /runs/:id.
  app.post('/runs', createLimit, async (request, reply) => {
    const body = z
      .object({
        suiteId: z.string(),
        targetId: z.string(),
        repeat: z.number().int().min(1).max(10).default(1),
        concurrency: z.number().int().min(1).max(10).default(3),
        judgeTargetId: z.string().optional(),
      })
      .parse(request.body);
    const { workspaceId } = request.user;

    const suite = db.prepare('SELECT id FROM suites WHERE id = ? AND workspace_id = ?').get(body.suiteId, workspaceId);
    if (!suite) return reply.code(404).send({ error: 'suite_not_found' });
    const target = db.prepare('SELECT id FROM targets WHERE id = ? AND workspace_id = ?').get(body.targetId, workspaceId);
    if (!target) return reply.code(404).send({ error: 'target_not_found' });
    if (body.judgeTargetId) {
      const judge = db.prepare('SELECT id FROM targets WHERE id = ? AND workspace_id = ?').get(body.judgeTargetId, workspaceId);
      if (!judge) return reply.code(404).send({ error: 'judge_not_found' });
    }
    const needsJudge = db.prepare("SELECT 1 FROM test_cases WHERE suite_id = ? AND grader_config LIKE '%\"llm_judge\"%' LIMIT 1").get(body.suiteId);
    if (needsJudge && !body.judgeTargetId) {
      return reply.code(400).send({ error: 'judge_required', message: 'This suite has llm_judge cases. Pick a judge: another AI that grades the answers.' });
    }

    const cases = db.prepare('SELECT id FROM test_cases WHERE suite_id = ? ORDER BY rowid').all(body.suiteId) as { id: string }[];
    if (cases.length === 0) {
      return reply.code(400).send({ error: 'suite_has_no_cases', message: 'Add test cases to the suite first.' });
    }
    const total = cases.length * body.repeat;
    if (total > MAX_JOBS_PER_RUN) {
      return reply.code(400).send({ error: 'run_too_large', message: `A run can have at most ${MAX_JOBS_PER_RUN} test executions.` });
    }

    // Create the run plus one empty "pending" result row per execution, all at once
    const runId = randomUUID();
    db.transaction(() => {
      db.prepare("INSERT INTO runs (id, suite_id, target_id, judge_target_id, status, repeat) VALUES (?, ?, ?, ?, 'queued', ?)").run(
        runId,
        body.suiteId,
        body.targetId,
        body.judgeTargetId ?? null,
        body.repeat,
      );
      const insert = db.prepare('INSERT INTO results (id, run_id, test_case_id, attempt) VALUES (?, ?, ?, ?)');
      for (let attempt = 1; attempt <= body.repeat; attempt++) {
        for (const c of cases) insert.run(randomUUID(), runId, c.id, attempt);
      }
    })();

    void executeRun(runId, body.concurrency); // not awaited: runs in the background
    return reply.code(202).send({ id: runId, status: 'queued', total });
  });

  app.get('/runs', async (request) => {
    const { suiteId } = z.object({ suiteId: z.string().optional() }).parse(request.query);
    const rows = db
      .prepare(
        `SELECT r.* FROM runs r JOIN suites s ON s.id = r.suite_id
         WHERE s.workspace_id = ? AND (? IS NULL OR r.suite_id = ?)
         ORDER BY r.rowid DESC LIMIT 50`,
      )
      .all(request.user.workspaceId, suiteId ?? null, suiteId ?? null) as RunRow[];
    return rows.map(runPublic);
  });

  app.get('/runs/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const run = findRun(id, request.user.workspaceId);
    if (!run) return reply.code(404).send({ error: 'not_found' });
    return runPublic(run);
  });

  // Every test case's output and verdict. Filter with ?status=passed|failed|error|pending|ungraded
  app.get('/runs/:id/results', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    if (!findRun(id, request.user.workspaceId)) return reply.code(404).send({ error: 'not_found' });

    const { status, limit, offset } = z
      .object({
        status: z.enum(['passed', 'failed', 'error', 'pending', 'ungraded']).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(request.query);

    const filters: Record<string, string> = {
      passed: 'AND res.passed = 1',
      failed: 'AND res.passed = 0 AND res.error IS NULL',
      error: 'AND res.error IS NOT NULL',
      pending: 'AND res.output IS NULL AND res.error IS NULL',
      ungraded: 'AND res.passed IS NULL AND res.output IS NOT NULL',
    };

    const rows = db
      .prepare(
        `SELECT res.*, c.input, c.expected FROM results res
         JOIN test_cases c ON c.id = res.test_case_id
         WHERE res.run_id = ? ${status ? filters[status] : ''}
         ORDER BY res.rowid LIMIT ? OFFSET ?`,
      )
      .all(id, limit, offset) as (Record<string, unknown> & {
      id: string; test_case_id: string; input: string; expected: string | null; attempt: number;
      output: string | null; error: string | null; passed: number | null; score: number | null;
      grader_results: string | null; input_tokens: number | null; output_tokens: number | null;
      latency_ms: number | null; cost_usd: number | null;
    })[];

    return rows.map((r) => ({
      id: r.id,
      caseId: r.test_case_id,
      input: r.input,
      expected: r.expected,
      attempt: r.attempt,
      output: r.output,
      error: r.error,
      passed: r.passed === null ? null : r.passed === 1,
      score: r.score,
      graderResults: r.grader_results ? JSON.parse(r.grader_results) : [],
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      latencyMs: r.latency_ms,
      costUsd: r.cost_usd,
    }));
  });
}
