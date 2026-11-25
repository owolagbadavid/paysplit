import { and, eq, lt, sql } from 'drizzle-orm';
import type { Ctx } from '../context.ts';
import type { Executor } from '../db/client.ts';
import { jobs } from '../db/schema.ts';
import { uniqueViolation } from '../lib/errors.ts';
import { raiseIssue } from './issues.ts';

export type JobHandler = (ctx: Ctx, payload: Record<string, unknown>) => Promise<void>;
export type JobHandlers = Record<string, JobHandler>;

const LOCK_SECONDS = 120;

/**
 * Queues work in the caller's transaction, so a job exists exactly when the change that needs it commits.
 * With a dedupe key, a second job is not added while one is already waiting.
 */
export async function enqueue(
  ex: Executor,
  type: string,
  payload: Record<string, unknown>,
  options: { dedupeKey?: string; runAt?: Date; maxAttempts?: number } = {},
): Promise<void> {
  await ex
    .insert(jobs)
    .values({
      type,
      payload,
      dedupeKey: options.dedupeKey ?? null,
      ...(options.runAt ? { runAt: options.runAt } : {}),
      ...(options.maxAttempts ? { maxAttempts: options.maxAttempts } : {}),
    })
    .onConflictDoNothing();
}

/** Claims due jobs, including ones whose worker died mid-run, and runs them. Returns how many ran. */
export async function runDueJobs(ctx: Ctx, handlers: JobHandlers, limit = 10): Promise<number> {
  const now = ctx.now();
  const claimed = await ctx.db
    .update(jobs)
    .set({
      status: 'running',
      attempts: sql`${jobs.attempts} + 1`,
      lockedUntil: new Date(now.getTime() + LOCK_SECONDS * 1000),
    })
    .where(
      sql`${jobs.id} in (
        select id from ${jobs}
         where (status = 'queued' and run_at <= ${now.toISOString()}::timestamptz)
            or (status = 'running' and locked_until < ${now.toISOString()}::timestamptz)
         order by run_at limit ${limit} for update skip locked)`,
    )
    .returning();

  await Promise.all(claimed.map((job) => runOne(ctx, handlers, job)));
  return claimed.length;
}

async function runOne(ctx: Ctx, handlers: JobHandlers, job: typeof jobs.$inferSelect): Promise<void> {
  try {
    const handler = handlers[job.type];
    if (!handler) throw new Error(`No handler for job type ${job.type}`);
    await handler(ctx, job.payload);
    await ctx.db
      .update(jobs)
      .set({ status: 'done', lockedUntil: null, lastError: null })
      .where(eq(jobs.id, job.id));
  } catch (error) {
    const message = (error as Error).message.slice(0, 500);
    if (job.attempts >= job.maxAttempts) {
      ctx.log.error({ err: error, jobId: job.id, type: job.type }, 'job gave up');
      await ctx.db
        .update(jobs)
        .set({ status: 'dead', lockedUntil: null, lastError: message })
        .where(eq(jobs.id, job.id));
      await raiseIssue(ctx.db, {
        kind: 'job_dead',
        severity: 'high',
        subject: job.id,
        detail: `${job.type}: ${message}`,
      });
      return;
    }
    ctx.log.warn(
      { err: error, jobId: job.id, type: job.type, attempts: job.attempts },
      'job failed, will retry',
    );
    const delaySeconds = Math.min(900, 5 * 2 ** (job.attempts - 1));
    const runAt = new Date(ctx.now().getTime() + delaySeconds * 1000);
    try {
      await ctx.db
        .update(jobs)
        .set({ status: 'queued', lockedUntil: null, lastError: message, runAt })
        .where(eq(jobs.id, job.id));
    } catch (requeueError) {
      // A newer job with the same dedupe key is already waiting and will do this work.
      if (!uniqueViolation(requeueError)) throw requeueError;
      await ctx.db
        .update(jobs)
        .set({ status: 'done', lockedUntil: null, lastError: message })
        .where(eq(jobs.id, job.id));
    }
  }
}

export async function pruneJobs(ctx: Ctx): Promise<void> {
  const cutoff = new Date(ctx.now().getTime() - 7 * 86_400_000);
  await ctx.db.delete(jobs).where(and(eq(jobs.status, 'done'), lt(jobs.updatedAt, cutoff)));
}
