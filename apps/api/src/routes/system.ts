import { sql } from 'drizzle-orm';
import type { Ctx } from '../context.ts';
import { safeEqual } from '../lib/crypto.ts';
import { unauthorized } from '../lib/errors.ts';
import { runDueJobs } from '../modules/jobs.ts';
import { jobHandlers, tick } from '../modules/scheduler.ts';
import { receivePaymentWebhook } from '../modules/webhooks.ts';
import { OK, type App } from './support.ts';

export function systemRoutes(root: App, ctx: Ctx) {
  const tags = ['System'];
  root.get(
    '/healthz',
    { config: { rateLimit: false }, schema: { tags, summary: 'Process is up' } },
    async () => OK,
  );
  root.get(
    '/readyz',
    { config: { rateLimit: false }, schema: { tags, summary: 'Database is reachable' } },
    async (_request, reply) => {
      try {
        await ctx.db.execute(sql`select 1`);
        return OK;
      } catch {
        return reply.status(503).send({ ok: false });
      }
    },
  );

  // Wakes a sleeping free-tier host and does whatever is due. Every task is claimed in the database, so calling
  // this often or twice at once is harmless.
  root.post(
    '/internal/tick',
    { schema: { tags, summary: 'Run due jobs and scheduled tasks' } },
    async (request) => {
      const given = request.headers.authorization ?? '';
      if (!safeEqual(given, `Bearer ${ctx.config.CRON_SECRET}`)) throw unauthorized('Wrong cron secret');
      const tasks = await tick(ctx);
      let jobs = 0;
      for (let round = 0; round < 20; round++) {
        const ran = await runDueJobs(ctx, jobHandlers);
        jobs += ran;
        if (ran === 0) break;
      }
      return { tasks, jobs };
    },
  );

  root.register(async (scope) => {
    // Signatures cover the exact bytes, so this scope keeps the body raw.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) =>
      done(null, body),
    );
    scope.post(
      '/webhooks/payments',
      {
        config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
        schema: { tags, summary: 'Payment provider events' },
      },
      async (request) => {
        await receivePaymentWebhook(ctx, request.body as Buffer, request.headers);
        return OK;
      },
    );
  });
}
