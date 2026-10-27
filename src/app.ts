import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import { createHmac } from 'node:crypto';
import { ZodError } from 'zod';
import { config } from './config.js';
import { db } from './db.js';
import { authRoutes } from './routes/auth.js';
import { credentialRoutes } from './routes/credentials.js';
import { targetRoutes } from './routes/targets.js';
import { suiteRoutes } from './routes/suites.js';
import { runRoutes } from './routes/runs.js';
import { compareRoutes } from './routes/compare.js';
import { dashboardRoutes } from './dashboard.js';

export function buildApp() {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });

  // The JWT signing secret is derived from ENCRYPTION_KEY, so there is one less thing to configure.
  const jwtSecret = createHmac('sha256', config.ENCRYPTION_KEY).update('evalboard-jwt').digest('hex');

  app.register(cors);
  app.register(helmet);
  app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  app.register(jwt, { secret: jwtSecret });

  // Turn validation errors into clean 400 responses
  app.setErrorHandler((error: unknown, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: 'validation_error',
        issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return reply.send(error);
  });

  app.get('/health', async () => {
    db.prepare('SELECT 1').get(); // proves the database is reachable
    return { status: 'ok', time: new Date().toISOString() };
  });

  app.register(authRoutes);
  app.register(credentialRoutes);
  app.register(targetRoutes);
  app.register(suiteRoutes);
  app.register(runRoutes);
  app.register(compareRoutes);
  app.register(dashboardRoutes); // the web dashboard at /

  return app;
}
