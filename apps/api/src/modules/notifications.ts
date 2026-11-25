import { eq } from 'drizzle-orm';
import type { NotificationPrefs } from '@paysplit/core';
import type { Ctx } from '../context.ts';
import type { Executor } from '../db/client.ts';
import { emails, notifications, users } from '../db/schema.ts';
import { renderEmail, type EmailContent } from './email-templates.ts';
import { enqueue } from './jobs.ts';

/** Queues an email in the caller's transaction. The dedupe key makes repeats of an event send nothing. */
export async function queueEmail(
  ex: Executor,
  input: {
    to: string;
    userId?: string | undefined;
    template: string;
    dedupeKey: string;
    content: EmailContent;
    sensitive?: boolean;
  },
): Promise<void> {
  const { html, text } = renderEmail(input.content);
  const [row] = await ex
    .insert(emails)
    .values({
      recipient: input.to,
      userId: input.userId ?? null,
      template: input.template,
      subject: input.content.subject,
      html,
      text,
      sensitive: input.sensitive ?? false,
      dedupeKey: input.dedupeKey,
    })
    .onConflictDoNothing()
    .returning({ id: emails.id });
  if (row) await enqueue(ex, 'email.send', { emailId: row.id }, { maxAttempts: 6 });
}

export interface Notice {
  userId: string;
  type: string;
  /** Names one event. A second notice with the same key is dropped, in-app and by email. */
  dedupeKey: string;
  severity?: 'info' | 'success' | 'warning' | 'error';
  title: string;
  body: string;
  link?: string;
  /** Email to send as well. `pref` is the optional preference that can turn it off; without it the email is mandatory. */
  email?: { content: Omit<EmailContent, 'heading'> & { heading?: string }; pref?: keyof NotificationPrefs };
}

/** Records an in-app notification and, where asked and allowed, queues its email. */
export async function notify(ex: Executor, notice: Notice): Promise<void> {
  const [row] = await ex
    .insert(notifications)
    .values({
      userId: notice.userId,
      type: notice.type,
      severity: notice.severity ?? 'info',
      title: notice.title,
      body: notice.body,
      link: notice.link ?? null,
      dedupeKey: notice.dedupeKey,
    })
    .onConflictDoNothing()
    .returning({ id: notifications.id });
  if (!row || !notice.email) return;

  const [user] = await ex
    .select({ email: users.email, prefs: users.notificationPrefs, status: users.status })
    .from(users)
    .where(eq(users.id, notice.userId));
  if (!user || user.status !== 'active') return;
  if (notice.email.pref && user.prefs[notice.email.pref] === false) return;
  await queueEmail(ex, {
    to: user.email,
    userId: notice.userId,
    template: notice.type,
    dedupeKey: notice.dedupeKey,
    content: { heading: notice.title, ...notice.email.content },
  });
}

/** Sends one queued email and blanks the body of those that carried a code or a link granting access. */
export async function sendEmail(ctx: Ctx, emailId: string): Promise<void> {
  const [email] = await ctx.db.select().from(emails).where(eq(emails.id, emailId));
  if (!email || email.status === 'sent') return;
  await ctx.mailer.send({ to: email.recipient, subject: email.subject, html: email.html, text: email.text });
  await ctx.db
    .update(emails)
    .set({ status: 'sent', sentAt: ctx.now(), ...(email.sensitive ? { html: '', text: '' } : {}) })
    .where(eq(emails.id, emailId));
}
