import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useSearchParams, useParams, Link } from 'react-router';
import { get, query as qs } from '../../lib/api.ts';
import { dateTime, monthName, naira, title } from '../../lib/format.ts';
import type { Page, SalaryTransaction, SalaryTransactionDetail } from '../../lib/types.ts';
import {
  Async,
  Badge,
  EmptyState,
  Input,
  Notice,
  PageHeader,
  Pagination,
  Panel,
  Rows,
  SearchInput,
  Select,
  Status,
} from '../../ui/core.tsx';
import { SplitBreakdown } from '../splits.tsx';
import { Cell, Person, SplitState, Table } from './overview.tsx';

const SOURCE = { admin_test: 'Admin test', bank_transfer: 'Bank transfer' };

export function AdminSalary() {
  const [params, setParams] = useSearchParams();
  const read = (k: string) => params.get(k) ?? '';
  const page = Number(read('page')) || 1;
  const filters = { q: read('q'), splitState: read('splitState'), from: read('from'), to: read('to') };
  const patch = (changes: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries({ page: '', ...changes })) v ? next.set(k, v) : next.delete(k);
    setParams(next, { replace: true });
  };
  const list = useQuery({
    queryKey: ['admin', 'salary', filters, page],
    queryFn: () =>
      get<Page<SalaryTransaction>>(`/v1/admin/salary-transactions${qs({ ...filters, page, pageSize: 12 })}`),
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
  });
  return (
    <>
      <PageHeader
        title="Salary transactions"
        crumbs={[{ label: 'Dashboard', to: '/admin' }, { label: 'Salary' }]}
      />
      <Panel
        flush
        title="All confirmed salaries"
        actions={
          <SearchInput value={filters.q} onChange={(q) => patch({ q })} label="Search user or reference" />
        }
      >
        <div className="grid gap-3 border-b p-4 sm:grid-cols-3">
          <Select
            label="Split"
            value={filters.splitState}
            onChange={(e) => patch({ splitState: e.target.value })}
          >
            <option value="">Any</option>
            <option value="split">Split</option>
            <option value="held">Held for Run Now</option>
            <option value="no_rules">No active rules</option>
            <option value="awaiting">Waiting</option>
            <option value="not_eligible">Not eligible</option>
          </Select>
          <Input
            label="From"
            type="date"
            value={filters.from}
            onChange={(e) => patch({ from: e.target.value })}
          />
          <Input label="To" type="date" value={filters.to} onChange={(e) => patch({ to: e.target.value })} />
        </div>
        <Async query={list} rows={6}>
          {(data) =>
            data.total === 0 ? (
              <EmptyState title="No salary transactions">
                Salaries appear once the provider confirms them.
              </EmptyState>
            ) : (
              <Table
                min="min-w-[960px]"
                head={['Reference', 'User', 'Received', 'Cycle', 'Source', 'Split', 'Amount']}
              >
                {data.items.map((s) => (
                  <tr key={s.id} className="hover:bg-brand-wash">
                    <Cell>
                      <Link to={`/admin/salary/${s.id}`} className="num text-brand-ink hover:underline">
                        {s.reference}
                      </Link>
                    </Cell>
                    <Cell>
                      <Person id={s.userId} name={s.userName} email={s.userEmail} />
                    </Cell>
                    <Cell className="whitespace-nowrap">{dateTime(s.paidAt)}</Cell>
                    <Cell>{monthName(s.payCycle)}</Cell>
                    <Cell>
                      <Badge tone={s.source === 'admin_test' ? 'info' : 'neutral'}>{SOURCE[s.source]}</Badge>
                    </Cell>
                    <Cell>
                      <SplitState row={s} />
                    </Cell>
                    <Cell className="num font-medium">{naira(s.amount)}</Cell>
                  </tr>
                ))}
              </Table>
            )
          }
        </Async>
      </Panel>
      {list.data && <Pagination {...list.data} noun="salaries" onPage={(p) => patch({ page: String(p) })} />}
    </>
  );
}

const WHY: Record<string, string> = {
  held: 'This pay cycle had already been split automatically, so the money was left for the user to split with Run Now.',
  no_rules: 'The user had no active rules, so the money stayed in their salary account.',
  not_eligible: 'The user was not verified when it arrived. It will split once they are.',
  awaiting: 'The split is queued and will run shortly.',
};

export function AdminSalaryDetail() {
  const { id } = useParams();
  const query = useQuery({
    queryKey: ['admin', 'salary', id],
    queryFn: () => get<SalaryTransactionDetail>(`/v1/admin/salary-transactions/${id}`),
    refetchInterval: 8000,
  });
  return (
    <>
      <PageHeader
        title="Salary transaction"
        crumbs={[
          { label: 'Dashboard', to: '/admin' },
          { label: 'Salary', to: '/admin/salary' },
          { label: query.data?.reference ?? 'Salary' },
        ]}
      />
      <Async query={query} rows={6}>
        {(s) => (
          <div className="space-y-5">
            <Panel title={naira(s.amount)} actions={<Status value="confirmed" />}>
              <Rows
                items={[
                  [
                    'User',
                    <Link to={`/admin/users/${s.userId}`} className="text-brand-ink hover:underline">
                      {s.userName}
                    </Link>,
                  ],
                  ['Pay cycle', monthName(s.payCycle)],
                  ['Source', SOURCE[s.source]],
                  ['Channel', title(s.channel)],
                  ['Provider', title(s.provider)],
                  ['Provider reference', <span className="break-all">{s.providerReference}</span>],
                  ['Provider fee, paid by PaySplit', naira(s.providerFee)],
                  ['Paid', dateTime(s.paidAt)],
                  ['Confirmed', dateTime(s.confirmedAt)],
                ]}
              />
            </Panel>
            {s.executions.length === 0 && (
              <Notice title="No split yet">{WHY[s.splitState] ?? 'The split has not run.'}</Notice>
            )}
            {s.executions.map((e) => (
              <section key={e.id} aria-label={e.reference}>
                <h2 className="mb-3 font-semibold">
                  {e.trigger === 'manual' ? 'Run Now' : 'Automatic split'} {e.reference}
                </h2>
                <SplitBreakdown split={e} />
              </section>
            ))}
          </div>
        )}
      </Async>
    </>
  );
}
