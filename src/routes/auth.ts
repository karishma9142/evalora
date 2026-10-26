import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db } from '../db.js';
import { hashPassword, verifyPassword } from '../lib/crypto.js';
import { requireAuth } from '../lib/auth.js';

const credentialsSchema = z.object({
  email: z.string().email().max(254).transform((e) => e.toLowerCase()),
  password: z.string().min(8).max(200),
});

// Limits repeated attempts from one IP (slows down password guessing)
const strictLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/register', strictLimit, async (request, reply) => {
    const { email, password } = credentialsSchema.parse(request.body);

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) return reply.code(409).send({ error: 'email_already_registered' });

    const userId = randomUUID();
    const workspaceId = randomUUID();
    const passwordHash = await hashPassword(password);

    // Create the user and their first workspace together, or not at all
    db.transaction(() => {
      db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)').run(
        userId,
        email,
        passwordHash,
      );
      db.prepare('INSERT INTO workspaces (id, name, owner_id) VALUES (?, ?, ?)').run(
        workspaceId,
        'My Workspace',
        userId,
      );
    })();

    const token = app.jwt.sign({ userId, workspaceId }, { expiresIn: '7d' });
    return reply.code(201).send({ token, user: { id: userId, email }, workspaceId });
  });

  app.post('/auth/login', strictLimit, async (request, reply) => {
    const { email, password } = credentialsSchema.parse(request.body);

    const user = db
      .prepare('SELECT id, email, password_hash FROM users WHERE email = ?')
      .get(email) as { id: string; email: string; password_hash: string } | undefined;

    // Same error for "no such user" and "wrong password" so attackers can't tell which emails exist
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return reply.code(401).send({ error: 'invalid_credentials' });
    }

    const workspace = db
      .prepare('SELECT id FROM workspaces WHERE owner_id = ? ORDER BY created_at LIMIT 1')
      .get(user.id) as { id: string };

    const token = app.jwt.sign({ userId: user.id, workspaceId: workspace.id }, { expiresIn: '7d' });
    return { token, user: { id: user.id, email: user.email }, workspaceId: workspace.id };
  });

  app.get('/me', { preHandler: requireAuth }, async (request) => {
    const { userId, workspaceId } = request.user;
    const user = db.prepare('SELECT id, email FROM users WHERE id = ?').get(userId);
    return { user, workspaceId };
  });
}
