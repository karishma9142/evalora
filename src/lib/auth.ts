import type { FastifyReply, FastifyRequest } from 'fastify';

export type AuthPayload = { userId: string; workspaceId: string };

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AuthPayload;
    user: AuthPayload;
  }
}

// Use as a route hook:  { preHandler: requireAuth }
// After it passes, request.user.userId and request.user.workspaceId are available.
export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify();
  } catch {
    return reply.code(401).send({ error: 'unauthorized' });
  }
}
