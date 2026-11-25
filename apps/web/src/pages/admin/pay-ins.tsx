import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { FlaskConical, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { api, get, query as qs, queryClient } from '../../lib/api.ts';
import { dateTime, monthName, naira, title } from '../../lib/format.ts';
import type { Page, PayIn, PayInRow } from '../../lib/types.ts';
import {
  Async,
  Button,
  buttonClass,
  EmptyState,
  FormError,
  Notice,
  PageHeader,
  Pagination,
  Panel,
  Rows,
  Status,
  Tile,
} from '../../ui/core.tsx';
import { SplitBreakdown } from '../splits.tsx';
import { Cell, SplitState, Table } from './overview.tsx';

export function AdminPayIns() {
  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: ['admin', 'pay-ins', page],
    queryFn: () => get<Page<PayInRow>>(`/v1/admin/pay-ins${qs({ page, pageSize: 12 })}`),
    placeholderData: keepPreviousData,
    refetchInterval: 10_000,
  });
  return (
    <>
      <PageHeader
        title="Test salary runs"
        crumbs={[{ label: 'Dashboard', to: '/admin' }, { label: 'Test runs' }]}
        actions={
          <Link to="/admin/users?verification=verified" className={buttonClass()}>
            New test salary
          </Link>
        }
      />
      <Panel flush title="Runs started by administrators">
        <Async query={list} rows={5}>
          {(data) =>
            data.total === 0 ? (
              <EmptyState icon={<FlaskConical className="size-5" />} title="No admin test runs yet">
                Choose a verified user and send a test salary to see their rules run.
              </EmptyState>
            ) : (
              <Table
                min="min-w-[960px]"
                head={[
                  'Started',
                  'User',
                  'Administrator',
                  'Cycle',
                  'Submitted',
                  'Confirmed',
                  'Pay-in',
                  'Split',
                ]}
              >
                {data.items.map((r) => (
                  <tr key={r.id} className="hover:bg-brand-wash">
                    <Cell>
                      <Link to={`/admin/pay-ins/${r.id}`} className="text-brand-ink hover:underline">
                        {dateTime(r.createdAt)}
                      </Link>
                    </Cell>
                    <Cell>
                      <Link to={`/admin/users/${r.userId}`} className="font-medium hover:underline">
                        {r.userName}
                      </Link>
                    </Cell>
                    <Cell>{r.adminName}</Cell>
                    <Cell>{monthName(r.payCycle)}</Cell>
                    <Cell className="num">{naira(r.amount)}</Cell>
                    <Cell className="num">
                      {r.confirmedAmount === null ? (
                        <span className="text-muted">Not confirmed</span>
                      ) : (
                        naira(r.confirmedAmount)
                      )}
                    </Cell>
                    <Cell>
                      <Status value={r.status} />
                    </Cell>
                    <Cell>
                      {r.splitState ? (
                        <SplitState row={r} />
                      ) : (
                        <span className="text-muted">Not started</span>
                      )}
                    </Cell>
                  </tr>
                ))}
              </Table>
            )
          }
        </Async>
      </Panel>
      {list.data && list.data.total > 0 && <Pagination {...list.data} noun="runs" onPage={setPage} />}
    </>
  );
}

const SPLIT_NOTE: Record<string, [string, string]> = {
  held: [
    'Not split automatically',
    'This pay cycle had already been split. The user can split it with Run Now.',
  ],
  no_rules: ['Nothing to run', 'The user had no active rules, so the salary stayed in their salary account.'],
  not_eligible: ['Not split', 'The user was no longer eligible when the salary arrived.'],
  awaiting: ['Split queued', 'The salary is confirmed and the split is about to run.'],
};

export function AdminPayIn() {
  const { id } = useParams();
  const query = useQuery({
    queryKey: ['admin', 'pay-ins', 'detail', id],
    queryFn: () => get<PayIn>(`/v1/admin/pay-ins/${id}`),
    refetchInterval: (q) => {
      const run = q.state.data;
      const settled =
        run?.status === 'failed' ||
        (run?.status === 'confirmed' && run.splitState !== 'awaiting' && run.execution?.status !== 'pending');
      return settled ? false : 2500;
    },
  });
  const refresh = useMutation({
    mutationFn: () => api<PayIn>('POST', `/v1/admin/pay-ins/${id}/refresh`),
    onSuccess: (run) => queryClient.setQueryData(['admin', 'pay-ins', 'detail', id], run),
  });
  return (
    <>
      <PageHeader
        title="Test salary run"
        crumbs={[
          { label: 'Dashboard', to: '/admin' },
          { label: 'Test runs', to: '/admin/pay-ins' },
          { label: 'Run' },
        ]}
      />
      <Async query={query} rows={6}>
        {(run) => (
          <div className="space-y-5">
            {run.status === 'failed' && (
              <Notice tone="bad" title="The pay-in failed">
                {run.failureReason ?? 'The provider declined it.'} Nothing was credited.
              </Notice>
            )}
            {(run.status === 'awaiting_confirmation' || run.status === 'submitting') && (
              <Notice
                title="Waiting for the provider to confirm"
                action={
                  <Button
                    size="sm"
                    variant="outline"
                    icon={<RefreshCw className="size-3.5" aria-hidden />}
                    busy={refresh.isPending}
                    onClick={() => refresh.mutate()}
                  >
                    Check now
                  </Button>
                }
              >
                Nothing is credited or split until the provider confirms the payment. This page updates by
                itself.
              </Notice>
            )}
            <FormError error={refresh.error} />
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <Tile label="Submitted" value={naira(run.amount)} note={`By ${run.adminName}`} />
              <Tile
                label="Confirmed"
                value={run.confirmedAmount === null ? 'Not yet' : naira(run.confirmedAmount)}
                note="By the provider"
              />
              <Tile label="Pay-in" value={<Status value={run.status} />} note={monthName(run.payCycle)} />
              <Tile
                label="Split"
                value={
                  run.execution ? (
                    <Status value={run.execution.status} />
                  ) : run.splitState ? (
                    <Status value={run.splitState} />
                  ) : (
                    'Not started'
                  )
                }
              />
            </div>
            <Panel title="Run details">
              <Rows
                items={[
                  [
                    'User',
                    <Link to={`/admin/users/${run.userId}`} className="text-brand-ink hover:underline">
                      {run.userName}
                    </Link>,
                  ],
                  ['Started', dateTime(run.createdAt)],
                  ['Provider', title(run.provider)],
                  ['Provider reference', <span className="break-all">{run.providerReference}</span>],
                  ...(run.salaryPaymentId
                    ? ([
                        [
                          'Salary transaction',
                          <Link
                            to={`/admin/salary/${run.salaryPaymentId}`}
                            className="text-brand-ink hover:underline"
                          >
                            Open
                          </Link>,
                        ],
                      ] as [string, React.ReactNode][])
                    : []),
                ]}
              />
            </Panel>
            {run.splitState && SPLIT_NOTE[run.splitState] && (
              <Notice title={SPLIT_NOTE[run.splitState]![0]}>{SPLIT_NOTE[run.splitState]![1]}</Notice>
            )}
            {run.execution && <SplitBreakdown split={run.execution} />}
          </div>
        )}
      </Async>
    </>
  );
}
