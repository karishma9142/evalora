import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db } from '../db.js';
import { decrypt } from '../lib/crypto.js';
import { requireAuth } from '../lib/auth.js';
import { calcCost } from '../lib/cost.js';
import { getProvider, ProviderError } from '../providers/index.js';

const createSchema = z.object({
  name: z.string().min(1).max(100),
  credentialId: z.string(),
  model: z.string().min(1).max(200),
  systemPrompt: z.string().max(20_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(200_000).optional(),
  inputPricePerM: z.number().min(0).optional(),
  outputPricePerM: z.number().min(0).optional(),
});

type TargetRow = {
  id: string;
  name: string;
  credential_id: string;
  model: string;
  system_prompt: string | null;
  temperature: number | null;
  max_tokens: number | null;
  input_price_per_m: number | null;
  output_price_per_m: number | null;
  created_at: string;
};

const toPublic = (r: TargetRow) => ({
  id: r.id,
  name: r.name,
  credentialId: r.credential_id,
  model: r.model,
  systemPrompt: r.system_prompt,
  temperature: r.temperature,
  maxTokens: r.max_tokens,
  inputPricePerM: r.input_price_per_m,
  outputPricePerM: r.output_price_per_m,
  createdAt: r.created_at,
});

// Each test call spends the user's own money, so keep it fairly tight
const testLimit = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };

export async function targetRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.post('/targets', async (request, reply) => {
    const body = createSchema.parse(request.body);
    const { workspaceId } = request.user;

    // The credential must belong to the same workspace
    const cred = db
      .prepare('SELECT id FROM credentials WHERE id = ? AND workspace_id = ?')
      .get(body.credentialId, workspaceId);
    if (!cred) return reply.code(404).send({ error: 'credential_not_found' });

    const id = randomUUID();
    db.prepare(
      `INSERT INTO targets
        (id, workspace_id, credential_id, name, model, system_prompt, temperature,
         max_tokens, input_price_per_m, output_price_per_m)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      workspaceId,
      body.credentialId,
      body.name,
      body.model,
      body.systemPrompt ?? null,
      body.temperature ?? null,
      body.maxTokens ?? null,
      body.inputPricePerM ?? null,
      body.outputPricePerM ?? null,
    );

    const row = db.prepare('SELECT * FROM targets WHERE id = ?').get(id) as TargetRow;
    return reply.code(201).send(toPublic(row));
  });

  app.get('/targets', async (request) => {
    const rows = db
      .prepare('SELECT * FROM targets WHERE workspace_id = ? ORDER BY created_at DESC')
      .all(request.user.workspaceId) as TargetRow[];
    return rows.map(toPublic);
  });

  app.delete('/targets/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { workspaceId } = request.user;

    const used = db
      .prepare('SELECT COUNT(*) AS n FROM runs WHERE target_id = ? OR judge_target_id = ?')
      .get(id, id) as { n: number };
    if (used.n > 0) {
      return reply.code(409).send({ error: 'target_in_use', message: 'This target has runs.' });
    }

    const result = db
      .prepare('DELETE FROM targets WHERE id = ? AND workspace_id = ?')
      .run(id, workspaceId);
    if (result.changes === 0) return reply.code(404).send({ error: 'not_found' });
    return reply.code(204).send();
  });

  // Send ONE prompt to the target's AI. Lets you check that a key + model work
  // before building a whole suite.
  app.post('/targets/:id/test', testLimit, async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { prompt } = z.object({ prompt: z.string().min(1).max(20_000) }).parse(request.body);
    const { workspaceId } = request.user;

    const row = db
      .prepare(
        `SELECT t.*, c.provider, c.base_url, c.encrypted_key
         FROM targets t JOIN credentials c ON c.id = t.credential_id
         WHERE t.id = ? AND t.workspace_id = ?`,
      )
      .get(id, workspaceId) as
      | (TargetRow & { provider: string; base_url: string | null; encrypted_key: string })
      | undefined;
    if (!row) return reply.code(404).send({ error: 'not_found' });

    try {
      // The key is decrypted only here, in memory, for the duration of this call
      const provider = getProvider({
        provider: row.provider,
        baseUrl: row.base_url,
        apiKey: decrypt(row.encrypted_key),
      });
      const result = await provider.generate({
        model: row.model,
        system: row.system_prompt,
        prompt,
        temperature: row.temperature,
        maxTokens: row.max_tokens,
      });
      return {
        output: result.text,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        latencyMs: result.latencyMs,
        costUsd: calcCost(
          result.inputTokens,
          result.outputTokens,
          row.input_price_per_m,
          row.output_price_per_m,
        ),
      };
    } catch (err) {
      if (err instanceof ProviderError) {
        return reply.code(502).send({ error: 'provider_error', message: err.message });
      }
      throw err;
    }
  });
}
