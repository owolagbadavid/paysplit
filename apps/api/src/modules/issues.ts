import { and, eq, sql } from 'drizzle-orm';
import type { Executor } from '../db/client.ts';
import { reconciliationIssues } from '../db/schema.ts';

export interface Issue {
  kind: string;
  severity: 'info' | 'high' | 'critical';
  subject: string;
  detail: string;
}

/** Records a mismatch for an administrator to look at. Repeats of an open issue only raise its count. */
export async function raiseIssue(ex: Executor, issue: Issue): Promise<void> {
  await ex
    .insert(reconciliationIssues)
    .values(issue)
    .onConflictDoUpdate({
      target: [reconciliationIssues.kind, reconciliationIssues.subject],
      targetWhere: sql`status = 'open'`,
      set: {
        detail: issue.detail,
        occurrences: sql`${reconciliationIssues.occurrences} + 1`,
        updatedAt: new Date(),
      },
    });
}

export async function resolveIssue(ex: Executor, kind: string, subject: string): Promise<void> {
  await ex
    .update(reconciliationIssues)
    .set({ status: 'resolved', resolvedAt: new Date() })
    .where(
      and(
        eq(reconciliationIssues.kind, kind),
        eq(reconciliationIssues.subject, subject),
        eq(reconciliationIssues.status, 'open'),
      ),
    );
}
