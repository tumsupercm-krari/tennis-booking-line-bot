import Fastify, { type FastifyInstance } from 'fastify';
import { webhookRoutes } from './webhook.route';
import { scheduleRoutes } from './schedule.route';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
  }
}

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: true });

  // LINE's webhook signature is computed over the exact raw request bytes.
  // Override the default JSON parser so we keep the raw string around
  // (on request.rawBody) instead of only the parsed object — verification
  // happens in webhook.route.ts before the body is trusted at all.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    req.rawBody = body as string;
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.register(webhookRoutes);
  app.register(scheduleRoutes);

  return app;
}
