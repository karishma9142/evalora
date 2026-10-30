import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Serves the landing page at http://localhost:3000/ and the dashboard at http://localhost:3000/app
// Only these fixed paths are served (no directory serving), so path traversal is impossible.
const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const files = [
  { url: '/', file: 'landing.html', type: 'text/html; charset=utf-8' }, // public landing page
  { url: '/app', file: 'index.html', type: 'text/html; charset=utf-8' }, // the dashboard
  { url: '/app.js', file: 'app.js', type: 'text/javascript; charset=utf-8' },
  { url: '/style.css', file: 'style.css', type: 'text/css; charset=utf-8' },
] as const;

export async function dashboardRoutes(app: FastifyInstance) {
  for (const { url, file, type } of files) {
    app.get(url, async (_request, reply) => {
      // Read on every request so edits show up on refresh; no-cache keeps the browser honest
      reply.type(type).header('cache-control', 'no-cache');
      return readFileSync(join(publicDir, file), 'utf8');
    });
  }
}