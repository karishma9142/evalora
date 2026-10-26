import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db } from '../db.js';
import { requireAuth } from '../lib/auth.js';
import { parseCsv } from '../lib/csv.js';

const MAX_CASES_PER_SUITE = 2000;
const MAX_CASES_PER_REQUEST = 500;

// ---------- Grader config (the graders themselves are built in the next step) ----------
const graderSchema = z.discriminatedUnion('type', [
  // output must equal `expected`
  z.object({ type: z.literal('exact_match'), caseSensitive: z.boolean().optional() }),
  // output must contain `value` (or `expected` if value is not given)
  z.object({
    type: z.literal('contains'),
    value: z.string().min(1).max(5000).optional(),
    caseSensitive: z.boolean().optional(),
  }),
  // output must match the regex
  z.object({
    type: z.literal('regex'),
    pattern: z.string().min(1).max(500),
    flags: z.string().regex(/^[imsu]*$/).max(4).optional(),
  }),
  // output must be valid JSON
  z.object({ type: z.literal('json_valid') }),
  // another AI scores the output against a rubric
  z.object({
    type: z.literal('llm_judge'),
    rubric: z.string().min(1).max(5000),
    passScore: z.number().min(0).max(1).optional(),
  }),
]);

const caseSchema = z
  .object({
    input: z.string().min(1).max(50_000),
    expected: z.string().max(50_000).optional(),
    context: z.string().max(100_000).optional(),
    tags: z.array(z.string().min(1).max(50)).max(20).default([]),
    graders: z.array(graderSchema).max(10).default([]),
  })
  .superRefine((c, ctx) => {
    c.graders.forEach((g, i) => {
      const needsExpected = g.type === 'exact_match' || (g.type === 'contains' && !g.value);
      if (needsExpected && !c.expected?.trim()) {
        ctx.addIssue({
          code: 'custom',
          path: ['graders', i],
          message: `${g.type} needs an "expected" value (or a "value" for contains)`,
        });
      }
      if (g.type === 'regex') {
        try {
          new RegExp(g.pattern, g.flags);
        } catch {
          ctx.addIssue({ code: 'custom', path: ['graders', i, 'pattern'], message: 'Invalid regular expression' });
        }
      }
    });
  });

type CaseInput = z.infer<typeof caseSchema>;

const suiteSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(1000).optional(),
});

// ---------- DB helpers ----------
type SuiteRow = { id: string; name: string; description: string | null; created_at: string; case_count?: number };
type CaseRow = {
  id: string;
  input: string;
  expected: string | null;
  context: string | null;
  tags: string;
  grader_config: string;
  created_at: string;
};

const suitePublic = (r: SuiteRow) => ({
  id: r.id,
  name: r.name,
  description: r.description,
  caseCount: r.case_count ?? 0,
  createdAt: r.created_at,
});

const casePublic = (r: CaseRow) => ({
  id: r.id,
  input: r.input,
  expected: r.expected,
  context: r.context,
  tags: JSON.parse(r.tags) as string[],
  graders: JSON.parse(r.grader_config) as unknown[],
  createdAt: r.created_at,
});

function findSuite(id: string, workspaceId: string): SuiteRow | undefined {
  // workspace_id in the WHERE clause = tenant isolation
  return db
    .prepare(
      `SELECT s.*, (SELECT COUNT(*) FROM test_cases c WHERE c.suite_id = s.id) AS case_count
       FROM suites s WHERE s.id = ? AND s.workspace_id = ?`,
    )
    .get(id, workspaceId) as SuiteRow | undefined;
}

function insertCases(suiteId: string, cases: CaseInput[]) {
  const stmt = db.prepare(
    `INSERT INTO test_cases (id, suite_id, input, expected, context, tags, grader_config)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  // All or nothing
  db.transaction(() => {
    for (const c of cases) {
      stmt.run(
        randomUUID(),
        suiteId,
        c.input,
        c.expected ?? null,
        c.context ?? null,
        JSON.stringify(c.tags),
        JSON.stringify(c.graders),
      );
    }
  })();
}

// CSV "grader" column shorthand: only graders that need no extra settings
const SIMPLE_GRADERS = ['exact_match', 'contains', 'json_valid'] as const;

const idParam = z.object({ id: z.string() });

export async function suiteRoutes(app: FastifyInstance) {
  // onRequest runs BEFORE the body is read, so anonymous callers can't make us parse big uploads
  app.addHook('onRequest', requireAuth);

  // Lets the import endpoint accept a raw CSV file (curl --data-binary @file.csv)
  app.addContentTypeParser('text/csv', { parseAs: 'string', bodyLimit: 2 * 1024 * 1024 }, (_req, body, done) =>
    done(null, body),
  );

  // ----- suites -----
  app.post('/suites', async (request, reply) => {
    const body = suiteSchema.parse(request.body);
    const id = randomUUID();
    db.prepare('INSERT INTO suites (id, workspace_id, name, description) VALUES (?, ?, ?, ?)').run(
      id,
      request.user.workspaceId,
      body.name,
      body.description ?? null,
    );
    return reply.code(201).send(suitePublic(findSuite(id, request.user.workspaceId)!));
  });

  app.get('/suites', async (request) => {
    const rows = db
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM test_cases c WHERE c.suite_id = s.id) AS case_count
         FROM suites s WHERE s.workspace_id = ? ORDER BY s.rowid DESC`,
      )
      .all(request.user.workspaceId) as SuiteRow[];
    return rows.map(suitePublic);
  });

  app.get('/suites/:id', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const suite = findSuite(id, request.user.workspaceId);
    if (!suite) return reply.code(404).send({ error: 'not_found' });
    return suitePublic(suite);
  });

  app.delete('/suites/:id', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    // Cases, runs and results of this suite are deleted with it (ON DELETE CASCADE)
    const result = db
      .prepare('DELETE FROM suites WHERE id = ? AND workspace_id = ?')
      .run(id, request.user.workspaceId);
    if (result.changes === 0) return reply.code(404).send({ error: 'not_found' });
    return reply.code(204).send();
  });

  // ----- test cases -----

  // Add one case:   { "input": "...", "expected": "...", "tags": [], "graders": [] }
  // Add many cases: { "cases": [ {...}, {...} ] }
  app.post('/suites/:id/cases', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const suite = findSuite(id, request.user.workspaceId);
    if (!suite) return reply.code(404).send({ error: 'not_found' });

    const raw = request.body as { cases?: unknown } | null;
    const cases =
      raw && Array.isArray(raw.cases)
        ? z.object({ cases: z.array(caseSchema).min(1).max(MAX_CASES_PER_REQUEST) }).parse(raw).cases
        : [caseSchema.parse(raw)];

    if ((suite.case_count ?? 0) + cases.length > MAX_CASES_PER_SUITE) {
      return reply.code(400).send({ error: 'suite_case_limit', message: `A suite can hold at most ${MAX_CASES_PER_SUITE} cases.` });
    }

    insertCases(id, cases);
    return reply.code(201).send({ added: cases.length });
  });

  app.get('/suites/:id/cases', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    if (!findSuite(id, request.user.workspaceId)) return reply.code(404).send({ error: 'not_found' });

    const { limit, offset } = z
      .object({
        limit: z.coerce.number().int().min(1).max(500).default(100),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(request.query);

    const total = (db.prepare('SELECT COUNT(*) AS n FROM test_cases WHERE suite_id = ?').get(id) as { n: number }).n;
    const rows = db
      .prepare('SELECT * FROM test_cases WHERE suite_id = ? ORDER BY rowid LIMIT ? OFFSET ?')
      .all(id, limit, offset) as CaseRow[];
    return { total, cases: rows.map(casePublic) };
  });

  app.delete('/suites/:id/cases/:caseId', async (request, reply) => {
    const { id, caseId } = z.object({ id: z.string(), caseId: z.string() }).parse(request.params);
    if (!findSuite(id, request.user.workspaceId)) return reply.code(404).send({ error: 'not_found' });
    const result = db.prepare('DELETE FROM test_cases WHERE id = ? AND suite_id = ?').run(caseId, id);
    if (result.changes === 0) return reply.code(404).send({ error: 'not_found' });
    return reply.code(204).send();
  });

  // ----- CSV import -----
  // Columns: input (required), expected, context, tags (separate with ; or |), grader (e.g. contains)
  app.post('/suites/:id/import-csv', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const suite = findSuite(id, request.user.workspaceId);
    if (!suite) return reply.code(404).send({ error: 'not_found' });

    if (typeof request.body !== 'string') {
      return reply.code(415).send({ error: 'send_csv', message: 'Send the file with Content-Type: text/csv' });
    }

    let records: string[][];
    try {
      records = parseCsv(request.body);
    } catch (err) {
      return reply.code(400).send({ error: 'invalid_csv', message: (err as Error).message });
    }
    if (records.length < 2) {
      return reply.code(400).send({ error: 'invalid_csv', message: 'Need a header row and at least one data row.' });
    }

    const headers = records[0].map((h) => h.trim().toLowerCase());
    if (!headers.includes('input')) {
      return reply.code(400).send({ error: 'invalid_csv', message: 'The header row must include an "input" column.' });
    }
    const col = (row: string[], name: string) => {
      const idx = headers.indexOf(name);
      return idx === -1 ? '' : (row[idx] ?? '').trim();
    };

    const cases: CaseInput[] = [];
    const errors: { row: number; message: string }[] = [];

    records.slice(1).forEach((row, i) => {
      const rowNumber = i + 2; // header is row 1
      if (row.every((cell) => cell.trim() === '')) return; // skip blank lines

      const graderNames = col(row, 'grader').split(/[;|]/).map((g) => g.trim()).filter(Boolean);
      const unknown = graderNames.find((g) => !(SIMPLE_GRADERS as readonly string[]).includes(g));
      if (unknown) {
        errors.push({ row: rowNumber, message: `Unknown grader "${unknown}". Use: ${SIMPLE_GRADERS.join(', ')}` });
        return;
      }

      const parsed = caseSchema.safeParse({
        input: col(row, 'input'),
        expected: col(row, 'expected') || undefined,
        context: col(row, 'context') || undefined,
        tags: col(row, 'tags').split(/[;|]/).map((t) => t.trim()).filter(Boolean),
        graders: graderNames.map((type) => ({ type })),
      });
      if (!parsed.success) {
        const msg = parsed.error.issues.map((x) => `${x.path.map(String).join('.')}: ${x.message}`).join('; ');
        errors.push({ row: rowNumber, message: msg });
        return;
      }
      cases.push(parsed.data);
    });

    // All or nothing: if any row is bad, import nothing and say exactly which rows
    if (errors.length > 0) {
      return reply.code(400).send({ error: 'invalid_rows', imported: 0, errors: errors.slice(0, 50) });
    }
    if (cases.length === 0) return reply.code(400).send({ error: 'invalid_csv', message: 'No data rows found.' });
    if ((suite.case_count ?? 0) + cases.length > MAX_CASES_PER_SUITE) {
      return reply.code(400).send({ error: 'suite_case_limit', message: `A suite can hold at most ${MAX_CASES_PER_SUITE} cases.` });
    }

    insertCases(id, cases);
    return reply.code(201).send({ imported: cases.length });
  });
}
