import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db.js';
import { decrypt } from '../lib/crypto.js';
import { requireAuth } from '../lib/auth.js';
import { askJudge } from '../graders/judge.js';
import { JUDGE_CHECK_CASES } from '../graders/judgeCheck.js';
import { getProvider, ProviderError } from '../providers/index.js';

const limit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

export async function judgeCheckRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  // Tests a target AS A JUDGE on 6 examples with known answers, so you can see whether it is
  // reliable enough to grade your suite before you trust its verdicts.
  app.post('/targets/:id/judge-check', limit, async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const row = db
      .prepare(
        `SELECT t.model, t.temperature, c.provider, c.base_url, c.encrypted_key
         FROM targets t JOIN credentials c ON c.id = t.credential_id
         WHERE t.id = ? AND t.workspace_id = ?`,
      )
      .get(id, request.user.workspaceId) as
      | { model: string; temperature: number | null; provider: string; base_url: string | null; encrypted_key: string }
      | undefined;
    if (!row) return reply.code(404).send({ error: 'not_found' });

    try {
      const provider = getProvider({ provider: row.provider, baseUrl: row.base_url, apiKey: decrypt(row.encrypted_key) });
      const judge = { model: row.model, temperature: row.temperature, generate: (req: Parameters<typeof provider.generate>[0]) => provider.generate(req) };

      const results = [];
      for (const c of JUDGE_CHECK_CASES) {
        // one at a time, so a small local model is not overloaded
        const v = await askJudge(judge, { type: 'llm_judge' }, { input: c.input, expected: c.expected, output: c.answer });
        results.push({
          label: c.label,
          answer: c.answer,
          shouldPass: c.shouldPass,
          verdict: v.verdict,
          correct: (v.verdict === 'pass') === c.shouldPass && v.verdict !== 'invalid',
          reason: v.reason,
          raw: v.raw.slice(0, 300),
        });
      }

      const correct = results.filter((r) => r.correct).length;
      const rating = correct >= 5 ? 'usable' : correct === 4 ? 'unreliable' : 'not_usable';
      return {
        model: row.model,
        correct,
        total: results.length,
        rating,
        message:
          rating === 'usable'
            ? 'This model judged most examples correctly. It is usable, but spot-check its verdicts.'
            : rating === 'unreliable'
              ? 'This model got several examples wrong. Treat its verdicts with caution, or use a stronger judge.'
              : 'This model is not reliable enough to judge. Use a larger model as the judge, or use the "keywords" grader for factual answers.',
        results,
      };
    } catch (err) {
      if (err instanceof ProviderError) return reply.code(502).send({ error: 'provider_error', message: err.message });
      throw err;
    }
  });
}
