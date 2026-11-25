import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router';
import { PageBody } from '../layouts/app.tsx';
import { get } from '../lib/api.ts';
import { dateTime, monthName, naira, ruleValue, skipText } from '../lib/format.ts';
import type { SplitDetail } from '../lib/types.ts';
import { Async, Notice, PageHeader, Panel, Status, Tile } from '../ui/core.tsx';
import { TransactionDrawer } from '../ui/tables.tsx';

const EXPLAIN: Record<string, [tone: 'info' | 'warn' | 'bad', title: string, text: string]> = {
  pending: [
    'info',
    'Waiting for confirmation',
    'Some transfers are still with the bank. They are not counted as paid until the bank confirms them.',
  ],
  partially_completed: [
    'warn',
    'Partially completed',
    'Some rules were skipped or failed. That money is still in your salary account.',
  ],
  failed: [
    'bad',
    'Nothing was allocated',
    'No rule could be completed. Your salary is still in your salary account.',
  ],
};

/** One execution: totals on top, then every rule with what it asked for, what it got and why. */
export function SplitBreakdown({
  split,
  onOpen,
}: {
  split: SplitDetail;
  onOpen?: (transactionId: string) => void;
}) {
  const explain = EXPLAIN[split.status];
  return (
    <div className="space-y-4">
      {explain && (
        <Notice tone={explain[0]} title={explain[1]}>
          {explain[2]}
        </Notice>
      )}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <Tile
          label="Salary"
          value={naira(split.salaryAmount)}
          note={`Pay cycle ${monthName(split.payCycle)}`}
        />
        <Tile label="To wallets" value={naira(split.toWallets)} />
        <Tile label="To beneficiaries" value={naira(split.toBeneficiaries)} />
        <Tile
          label="Pending"
          value={naira(split.pending)}
          note={split.pending ? 'Held until confirmed' : 'Nothing in flight'}
        />
        <Tile
          label="Remaining"
          value={naira(split.remaining)}
          note="In the salary account after this split"
        />
      </div>
      <Panel flush title="Breakdown" actions={<Status value={split.status} />}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-[13px]">
            <thead className="text-muted">
              <tr className="border-b">
                {['Priority', 'Rule', 'Destination', 'Method', 'Requested', 'Allocated', 'Status'].map(
                  (h) => (
                    <th key={h} className="px-4 py-3 font-normal">
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody className="divide-y">
              {split.allocations.map((a) => (
                <tr key={a.id}>
                  <td className="num px-4 py-3">{a.rule.priority}</td>
                  <td className="px-4 py-3 font-medium">{a.rule.name}</td>
                  <td className="px-4 py-3">
                    {a.rule.destinationName}
                    <span className="block text-[12px] text-muted">{a.rule.destinationDetail}</span>
                  </td>
                  <td className="num px-4 py-3">{ruleValue(a.rule)}</td>
                  <td className="num px-4 py-3">{naira(a.requested)}</td>
                  <td className="num px-4 py-3 font-medium">
                    {naira(
                      a.status === 'success' || a.status === 'pending' || a.status === 'retrying'
                        ? a.allocated
                        : 0,
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className="flex flex-wrap items-center gap-2">
                      <Status value={a.status} />
                      {a.transactionId && onOpen && (
                        <button
                          type="button"
                          onClick={() => onOpen(a.transactionId!)}
                          className="min-h-6 text-brand-ink hover:underline"
                        >
                          Details
                        </button>
                      )}
                    </span>
                    {a.skipReason && (
                      <span className="mt-1 block text-[12px] text-muted">
                        {skipText(a.skipReason)}
                        {a.skipReason === 'insufficient_funds' &&
                          `. ${naira(a.availableBefore)} was available.`}
                      </span>
                    )}
                    {a.failureReason && (
                      <span className="mt-1 block text-[12px] text-bad">
                        {a.failureReason}. Money returned.
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

export function SplitPage() {
  const { id } = useParams();
  const [open, setOpen] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['splits', id],
    queryFn: () => get<SplitDetail>(`/v1/splits/${id}`),
    refetchInterval: (q) => (q.state.data?.status === 'pending' ? 4000 : false),
  });
  return (
    <PageBody>
      <PageHeader
        title="Split breakdown"
        crumbs={[
          { label: 'Dashboard', to: '/dashboard' },
          { label: 'Split history', to: '/rules?tab=history' },
          { label: query.data?.reference ?? 'Split' },
        ]}
      />
      <Async query={query} rows={6}>
        {(split) => (
          <>
            <p className="mb-4 text-[13px] text-muted">
              {split.trigger === 'manual' ? 'You ran this with Run Now' : 'Ran automatically'} on{' '}
              {dateTime(split.createdAt)} from salary {split.salaryReference}.
            </p>
            <SplitBreakdown split={split} onOpen={setOpen} />
          </>
        )}
      </Async>
      <TransactionDrawer id={open} onClose={() => setOpen(null)} />
    </PageBody>
  );
}
