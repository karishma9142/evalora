import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db.js';
import { requireAuth } from '../lib/auth.js';
import { summarize } from './runs.js';

const round = (n: number, digits = 4) => Math.round(n * 10 ** digits) / 10 ** digits;
const diff = (a: number | null, b: number | null, digits = 4) => (a === null || b === null ? null : round(b - a, digits));

type ResultRow = {
  test_case_id: string;
  passed: number | null;
  output: string | null;
  error: string | null;
  grader_results: string | null;
};

// All finished results of a run, grouped by test case (a case has several rows when repeat > 1)
function groupByCase(runId: string): Map<string, ResultRow[]> {
  const rows = db
    .prepare(
      `SELECT test_case_id, passed, output, error, grader_results FROM results
       WHERE run_id = ? AND (output IS NOT NULL OR error IS NOT NULL) ORDER BY rowid`,
    )
    .all(runId) as ResultRow[];
  const map = new Map<string, ResultRow[]>();
  for (const row of rows) {
    const list = map.get(row.test_case_id) ?? [];
    list.push(row);
    map.set(row.test_case_id, list);
  }
  return map;
}

// One case in one run: its pass rate (0 to 1) plus a representative output and reason.
// With repeat > 1, the representative is the first failing attempt, if there is one.
function caseView(rows: ResultRow[]) {
  const graded = rows.filter((r) => r.passed !== null);
  if (graded.length === 0) return null; // ungraded: nothing to compare
  const passRate = graded.filter((r) => r.passed === 1).length / graded.length;
  const rep = graded.find((r) => r.passed === 0) ?? graded[0];

  let reason: string | null = rep.error;
  if (!reason && rep.grader_results) {
    const results = JSON.parse(rep.grader_results) as { passed: boolean; reason: string; skipped?: boolean }[];
    reason = (results.find((g) => !g.passed && !g.skipped) ?? results[0])?.reason ?? null;
  }
  return { passRate: round(passRate), output: rep.output, reason };
}

type RunInfo = { id: string; suite_id: string; status: string; target_name: string; model: string };

export async function compareRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  // Compare two runs of the same suite:  GET /runs/compare?a=RUN_A&b=RUN_B
  // "a" is the baseline (for example prompt v1), "b" is the new version (prompt v2).
  app.get('/runs/compare', async (request, reply) => {
    const { a, b } = z.object({ a: z.string(), b: z.string() }).parse(request.query);
    const { workspaceId } = request.user;
    if (a === b) return reply.code(400).send({ error: 'same_run', message: 'Pick two different runs.' });

    const load = (id: string) =>
      db
        .prepare(
          `SELECT r.id, r.suite_id, r.status, t.name AS target_name, t.model
           FROM runs r JOIN suites s ON s.id = r.suite_id JOIN targets t ON t.id = r.target_id
           WHERE r.id = ? AND s.workspace_id = ?`,
        )
        .get(id, workspaceId) as RunInfo | undefined;

    const runA = load(a);
    const runB = load(b);
    if (!runA || !runB) return reply.code(404).send({ error: 'not_found' });
    if (runA.suite_id !== runB.suite_id) {
      return reply.code(400).send({ error: 'different_suites', message: 'Both runs must use the same suite.' });
    }
    if (runA.status !== 'completed' || runB.status !== 'completed') {
      return reply.code(409).send({ error: 'run_not_finished', message: 'Both runs must be completed.' });
    }

    const casesById = new Map(
      (db.prepare('SELECT id, input, expected FROM test_cases WHERE suite_id = ?').all(runA.suite_id) as {
        id: string; input: string; expected: string | null;
      }[]).map((c) => [c.id, c]),
    );
    const groupedA = groupByCase(a);
    const groupedB = groupByCase(b);

    const regressions: object[] = [];
    const improvements: object[] = [];
    let unchanged = 0;
    let skipped = 0;
    const sortKeys = new WeakMap<object, number>();

    for (const [caseId, rowsA] of groupedA) {
      const rowsB = groupedB.get(caseId);
      const viewA = caseView(rowsA);
      const viewB = rowsB ? caseView(rowsB) : null;
      if (!viewA || !viewB) {
        skipped++; // case missing in one run, or ungraded
        continue;
      }
      const delta = round(viewB.passRate - viewA.passRate);
      if (delta === 0) {
        unchanged++;
        continue;
      }
      const entry = { caseId, input: casesById.get(caseId)?.input, expected: casesById.get(caseId)?.expected ?? null, a: viewA, b: viewB, delta };
      sortKeys.set(entry, delta);
      (delta < 0 ? regressions : improvements).push(entry);
    }
    // Worst regressions first, biggest improvements first
    regressions.sort((x, y) => (sortKeys.get(x) ?? 0) - (sortKeys.get(y) ?? 0));
    improvements.sort((x, y) => (sortKeys.get(y) ?? 0) - (sortKeys.get(x) ?? 0));

    const sa = summarize(a);
    const sb = summarize(b);

    return {
      suiteId: runA.suite_id,
      a: { runId: a, target: runA.target_name, model: runA.model, summary: sa },
      b: { runId: b, target: runB.target_name, model: runB.model, summary: sb },
      // Positive = B is higher than A
      delta: {
        passRate: diff(sa.passRate, sb.passRate),
        avgLatencyMs: diff(sa.avgLatencyMs, sb.avgLatencyMs, 0),
        costUsd: diff(sa.costUsd, sb.costUsd, 8),
        totalTokens: sb.inputTokens + sb.outputTokens - (sa.inputTokens + sa.outputTokens),
      },
      counts: {
        compared: regressions.length + improvements.length + unchanged,
        regressions: regressions.length,
        improvements: improvements.length,
        unchanged,
        skipped,
      },
      regressions,
      improvements,
    };
  });
}
