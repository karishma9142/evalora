import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db } from '../db.js';
import { encrypt } from '../lib/crypto.js';
import { requireAuth } from '../lib/auth.js';

const createSchema = z
  .object({
    label: z.string().min(1).max(100),
    provider: z.enum(['anthropic', 'openai-compatible']),
    baseUrl: z.string().url().optional(),
    apiKey: z.string().min(8).max(500),
  })
  .refine((v) => v.provider !== 'openai-compatible' || !!v.baseUrl, {
    message: 'baseUrl is required for openai-compatible providers',
    path: ['baseUrl'],
  });

type CredentialRow = {
  id: string;
  label: string;
  provider: string;
  base_url: string | null;
  key_last4: string;
  created_at: string;
};

// The ONLY shape we ever send back. The key itself (plain or encrypted) is never included.
const toPublic = (r: CredentialRow) => ({
  id: r.id,
  label: r.label,
  provider: r.provider,
  baseUrl: r.base_url,
  keyHint: `••••${r.key_last4}`,
  createdAt: r.created_at,
});

export async function credentialRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.post('/credentials', async (request, reply) => {
    const body = createSchema.parse(request.body);
    const { workspaceId } = request.user;
    const id = randomUUID();

    db.prepare(
      `INSERT INTO credentials (id, workspace_id, label, provider, base_url, encrypted_key, key_last4)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      workspaceId,
      body.label,
      body.provider,
      body.baseUrl ?? null,
      encrypt(body.apiKey),
      body.apiKey.slice(-4),
    );

    const row = db.prepare('SELECT * FROM credentials WHERE id = ?').get(id) as CredentialRow;
    return reply.code(201).send(toPublic(row));
  });

  app.get('/credentials', async (request) => {
    const rows = db
      .prepare('SELECT * FROM credentials WHERE workspace_id = ? ORDER BY created_at DESC')
      .all(request.user.workspaceId) as CredentialRow[];
    return rows.map(toPublic);
  });

  app.delete('/credentials/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { workspaceId } = request.user;

    const inUse = db
      .prepare(
        `SELECT COUNT(*) AS n FROM targets t
         JOIN credentials c ON c.id = t.credential_id
         WHERE c.id = ? AND c.workspace_id = ?`,
      )
      .get(id, workspaceId) as { n: number };
    if (inUse.n > 0) {
      return reply.code(409).send({ error: 'credential_in_use', message: 'Delete the targets that use this key first.' });
    }

    // workspace_id in the WHERE clause = tenant isolation: you can only delete your own
    const result = db
      .prepare('DELETE FROM credentials WHERE id = ? AND workspace_id = ?')
      .run(id, workspaceId);
    if (result.changes === 0) return reply.code(404).send({ error: 'not_found' });
    return reply.code(204).send();
  });
}
