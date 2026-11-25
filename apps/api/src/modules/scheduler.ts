import { and, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import {
  addCycles,
  dayNumber,
  formatMoney,
  isoDate,
  localDate,
  nextExpectedDate,
  payCycleFor,
} from '@paysplit/core';
import type { Ctx } from '../context.ts';
import { rules, salaryPayments, scheduledRuns, sessions, transactions, users } from '../db/schema.ts';
import { provisionSalaryAccount } from './salary-accounts.ts';
import { enqueue, pruneJobs, runDueJobs, type JobHandlers } from './jobs.ts';
import { eraseStaleIdentityNumbers } from './kyc.ts';
import { notify, sendEmail } from './notifications.ts';
import { checkBooks, confirmPayIns, recoverPayIns } from './reconciliation.ts';
import { runAutomaticSplit } from './splits.ts';
import { processTransfer, sweepOpenTransfers } from './transfers.ts';
import { processWebhook } from './webhooks.ts';

export const jobHandlers: JobHandlers = {
  'email.send': (ctx, p) => sendEmail(ctx, p.emailId as string),
  'webhook.process': (ctx, p) => processWebhook(ctx, p.webhookId as string),
  'split.automatic': (ctx, p) => runAutomaticSplit(ctx, p.salaryPaymentId as string),
  'transfer.process': (ctx, p) => processTransfer(ctx, p.transferId as string),
  'salary_account.provision': (ctx, p) => provisionSalaryAccount(ctx, p.userId as string),
};

/** Queues the automatic split for confirmed salaries whose job was lost, or whose owner has become eligible. */
async function catchUpSplits(ctx: Ctx): Promise<void> {
  const waiting = await ctx.db
    .select({ id: salaryPayments.id })
    .from(salaryPayments)
    .innerJoin(users, eq(users.id, salaryPayments.userId))
    .where(
      and(
        inArray(salaryPayments.splitState, ['awaiting', 'not_eligible']),
        eq(users.kycStatus, 'approved'),
        eq(users.status, 'active'),
      ),
    )
    .limit(200);
  for (const { id } of waiting)
    await enqueue(ctx.db, 'split.automatic', { salaryPaymentId: id }, { dedupeKey: `split:${id}` });
}

/** Tells people the day before their salary is expected, and after a due date passes with nothing received. */
async function remindSalaryDates(ctx: Ctx): Promise<void> {
  const now = ctx.now();
  const people = await ctx.db
    .select({ user: users })
    .from(users)
    .where(
      and(
        isNotNull(users.salaryDay),
        eq(users.status, 'active'),
        sql`exists (select 1 from ${rules} r where r.user_id = ${users.id} and r.status = 'active')`,
      ),
    );
  for (const { user } of people) {
    const today = dayNumber(localDate(now, user.timezone));
    const next = nextExpectedDate(user.salaryDay!, now, user.timezone);
    if (dayNumber(next) - today === 1) {
      await notify(ctx.db, {
        userId: user.id,
        type: 'upcoming_split',
        dedupeKey: `upcoming:${user.id}:${isoDate(next)}`,
        title: 'Salary expected tomorrow',
        body: 'Your split runs as soon as your salary is confirmed. Check your rules are up to date.',
        link: '/rules',
        email: {
          pref: 'upcoming_split',
          content: {
            subject: 'Your next split is coming up',
            paragraphs: [
              `Your salary is expected on ${isoDate(next)}. Your split runs once it is confirmed, not before.`,
            ],
            button: { label: 'Review your rules', url: `${ctx.config.APP_URL}/rules` },
          },
        },
      });
    }
    const yesterday = new Date(now.getTime() - 86_400_000);
    const due = nextExpectedDate(user.salaryDay!, yesterday, user.timezone);
    if (today - dayNumber(due) === 1) {
      const cycle = payCycleFor(yesterday, user.salaryDay, user.timezone);
      const received = await ctx.db.$count(
        salaryPayments,
        and(eq(salaryPayments.userId, user.id), eq(salaryPayments.payCycle, cycle)),
      );
      if (received === 0) {
        await notify(ctx.db, {
          userId: user.id,
          type: 'salary_awaited',
          dedupeKey: `awaited:${user.id}:${cycle}`,
          severity: 'warning',
          title: 'Salary not received yet',
          body: 'It was expected yesterday. Your split will run when it arrives.',
          link: '/dashboard',
        });
      }
    }
  }
}

/** Emails each person what last month's salary became. */
async function sendMonthlySummaries(ctx: Ctx): Promise<void> {
  const today = localDate(ctx.now());
  const month = addCycles(`${today.year}-${String(today.month).padStart(2, '0')}`, -1);
  const rows = await ctx.db
    .select({
      userId: transactions.userId,
      salary: sql<string>`coalesce(sum(${transactions.amount}) filter (where ${transactions.type} = 'salary_received'), 0)`,
      wallets: sql<string>`coalesce(sum(${transactions.amount}) filter (where ${transactions.type} = 'wallet_allocation'), 0)`,
      sent: sql<string>`coalesce(sum(${transactions.amount}) filter (where ${transactions.type} = 'beneficiary_transfer'), 0)`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.status, 'success'),
        sql`to_char(${transactions.createdAt} at time zone 'Africa/Lagos', 'YYYY-MM') = ${month}`,
      ),
    )
    .groupBy(transactions.userId);
  for (const row of rows) {
    const [salary, wallets, sent] = [BigInt(row.salary), BigInt(row.wallets), BigInt(row.sent)];
    await notify(ctx.db, {
      userId: row.userId,
      type: 'monthly_summary',
      dedupeKey: `summary:${row.userId}:${month}`,
      title: `Your ${month} summary`,
      body: `${formatMoney(salary)} received, ${formatMoney(wallets + sent)} allocated.`,
      link: '/transactions',
      email: {
        pref: 'monthly_summary',
        content: {
          subject: `Your PaySplit summary for ${month}`,
          paragraphs: ['Here is what happened to your salary last month.'],
          rows: [
            ['Salary received', formatMoney(salary)],
            ['Moved to wallets', formatMoney(wallets)],
            ['Sent to beneficiaries', formatMoney(sent)],
            ['Left in salary account', formatMoney(salary - wallets - sent)],
          ],
          button: { label: 'Open PaySplit', url: `${ctx.config.APP_URL}/transactions` },
        },
      },
    });
  }
}

async function housekeeping(ctx: Ctx): Promise<void> {
  await pruneJobs(ctx);
  await ctx.db
    .delete(sessions)
    .where(lt(sessions.expiresAt, new Date(ctx.now().getTime() - 30 * 86_400_000)));
  await ctx.db
    .delete(scheduledRuns)
    .where(lt(scheduledRuns.startedAt, new Date(ctx.now().getTime() - 60 * 86_400_000)));
}

interface Task {
  name: string;
  /** Window a moment falls in. A task runs once per window across every instance, and late if the host slept. */
  window: (now: Date) => string;
  run: (ctx: Ctx) => Promise<unknown>;
}

const everyMinutes = (n: number) => (now: Date) => String(Math.floor(now.getTime() / (n * 60_000)));
const daily = (now: Date) => isoDate(localDate(now));

export const TASKS: Task[] = [
  { name: 'catch-up-splits', window: everyMinutes(1), run: catchUpSplits },
  { name: 'sweep-transfers', window: everyMinutes(2), run: sweepOpenTransfers },
  { name: 'confirm-pay-ins', window: everyMinutes(1), run: confirmPayIns },
  { name: 'recover-pay-ins', window: everyMinutes(10), run: recoverPayIns },
  { name: 'erase-identity-numbers', window: everyMinutes(30), run: eraseStaleIdentityNumbers },
  { name: 'check-books', window: everyMinutes(60), run: checkBooks },
  { name: 'salary-reminders', window: daily, run: remindSalaryDates },
  { name: 'housekeeping', window: daily, run: housekeeping },
  {
    name: 'monthly-summaries',
    window: (now) => isoDate(localDate(now)).slice(0, 7),
    run: sendMonthlySummaries,
  },
];

/** Runs every task whose window has not been claimed. Claiming is an insert, so two instances cannot both win. */
export async function tick(ctx: Ctx): Promise<string[]> {
  const ran: string[] = [];
  for (const task of TASKS) {
    const window = task.window(ctx.now());
    const [claimed] = await ctx.db
      .insert(scheduledRuns)
      .values({ task: task.name, window, startedAt: ctx.now() })
      .onConflictDoNothing()
      .returning();
    if (!claimed) continue;
    try {
      await task.run(ctx);
      ran.push(task.name);
    } catch (error) {
      ctx.log.error({ err: error, task: task.name }, 'scheduled task failed');
      await ctx.db
        .delete(scheduledRuns)
        .where(and(eq(scheduledRuns.task, task.name), eq(scheduledRuns.window, window)));
    }
  }
  return ran;
}

/** Background loop: jobs about once a second, scheduled tasks about once every 15 seconds. */
export function startWorker(ctx: Ctx): () => Promise<void> {
  let stopping = false;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms).unref());
  const loop = async (work: () => Promise<number>, idleMs: number) => {
    while (!stopping) {
      let did = 0;
      try {
        did = await work();
      } catch (error) {
        ctx.log.error({ err: error }, 'worker loop error');
      }
      if (did === 0) await sleep(idleMs);
    }
  };
  const loops = [
    loop(() => runDueJobs(ctx, jobHandlers), 1000),
    loop(async () => {
      await tick(ctx);
      return 0;
    }, 15_000),
  ];
  return async () => {
    stopping = true;
    await Promise.race([Promise.all(loops), sleep(5000)]);
  };
}
