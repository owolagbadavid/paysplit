import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Eye } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { Link } from 'react-router';
import { get } from '../../lib/api.ts';
import { date, greeting, naira } from '../../lib/format.ts';
import { useAdminSession } from '../../lib/session.ts';
import type { AdminOverview, AdminUser, Page, SalaryTransaction } from '../../lib/types.ts';
import { Async, buttonClass, EmptyState, Notice, Panel, Status, Tile } from '../../ui/core.tsx';

export function Table({
  head,
  children,
  min = 'min-w-[720px]',
}: {
  head: ReactNode[];
  children: ReactNode;
  min?: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className={`w-full text-left text-[13px] ${min}`}>
        <thead className="text-muted">
          <tr className="border-b">
            {head.map((h, i) => (
              <th key={i} className="px-4 py-3 font-normal">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y">{children}</tbody>
      </table>
    </div>
  );
}

export const Cell = ({ children, className }: { children: ReactNode; className?: string }) => (
  <td className={`px-4 py-3 ${className ?? ''}`}>{children}</td>
);

export function Person({ id, name, email }: { id: string; name: string; email: string }) {
  return (
    <>
      <Link to={`/admin/users/${id}`} className="font-medium hover:underline">
        {name}
      </Link>
      <span className="block text-[12px] text-muted">{email}</span>
    </>
  );
}

/** The split result if there is one, otherwise why there is not. */
export function SplitState({ row }: { row: { splitState: string | null; executionStatus: string | null } }) {
  return <Status value={row.executionStatus ?? row.splitState ?? 'awaiting'} />;
}

export function AdminOverviewPage() {
  const admin = useAdminSession().data!.admin!;
  const overview = useQuery({
    queryKey: ['admin', 'overview'],
    queryFn: () => get<AdminOverview>('/v1/admin/overview'),
    refetchInterval: 20_000,
  });
  const users = useQuery({
    queryKey: ['admin', 'users', 'recent'],
    queryFn: () => get<Page<AdminUser>>('/v1/admin/users?pageSize=6'),
  });
  const salaries = useQuery({
    queryKey: ['admin', 'salary', 'recent'],
    queryFn: () => get<Page<SalaryTransaction>>('/v1/admin/salary-transactions?pageSize=6'),
    refetchInterval: 20_000,
  });
  useEffect(() => {
    document.title = 'Overview · Paysplit Admin';
  }, []);
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-[26px] tracking-tight">
          {greeting()}, {admin.firstName}!
        </h1>
        <p className="text-[13px] text-muted">
          {new Date().toLocaleDateString('en-GB', {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
            year: 'numeric',
          })}
        </p>
      </div>
      <Async query={overview} rows={2}>
        {(o) => (
          <>
            {o.openIssues > 0 && (
              <Notice
                tone="warn"
                title={`${o.openIssues} reconciliation ${o.openIssues === 1 ? 'issue needs' : 'issues need'} attention`}
                action={
                  <Link to="/admin/operations" className={buttonClass('outline', 'sm')}>
                    Review
                  </Link>
                }
              />
            )}
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <Tile label="Total Users" value={o.totalUsers} note="Registered users" to="/admin/users" />
              <Tile
                label="Verified Users"
                value={o.verifiedUsers}
                note={`${o.totalUsers ? Math.round((o.verifiedUsers / o.totalUsers) * 100) : 0}% verification rate`}
                to="/admin/users?verification=verified"
              />
              <Tile
                label="Unverified Users"
                value={o.unverifiedUsers}
                note={`${o.pendingVerification} started verification`}
                to="/admin/users?verification=unverified"
              />
              <Tile
                label="Total Salary Paid"
                value={naira(o.totalSalaryPaid)}
                note={`Confirmed, to ${o.paidUsers} ${o.paidUsers === 1 ? 'user' : 'users'}. Test mode.`}
                to="/admin/salary"
              />
            </div>
          </>
        )}
      </Async>
      <div className="grid gap-4 xl:grid-cols-2">
        <Panel
          flush
          title="Recent Users"
          actions={
            <Link
              to="/admin/users"
              className="flex min-h-6 items-center gap-1 text-[13px] text-brand-ink hover:underline"
            >
              Browse all <ChevronRight className="size-3.5" aria-hidden />
            </Link>
          }
        >
          <Async query={users} rows={5}>
            {(data) =>
              data.total === 0 ? (
                <EmptyState title="No users yet" />
              ) : (
                <Table
                  min="min-w-[480px]"
                  head={['User', 'Joined', 'Verification', <span className="sr-only">Open</span>]}
                >
                  {data.items.map((u) => (
                    <tr key={u.id} className="hover:bg-brand-wash">
                      <Cell>
                        <Person {...u} />
                      </Cell>
                      <Cell>{date(u.createdAt)}</Cell>
                      <Cell>
                        <Status value={u.kycStatus} />
                      </Cell>
                      <Cell className="text-right">
                        <Link
                          to={`/admin/users/${u.id}`}
                          aria-label={`Open ${u.name}`}
                          className="inline-flex size-8 items-center justify-center"
                        >
                          <Eye className="size-4" />
                        </Link>
                      </Cell>
                    </tr>
                  ))}
                </Table>
              )
            }
          </Async>
        </Panel>
        <Panel
          flush
          title="Recent Salary Payments"
          actions={
            <Link
              to="/admin/salary"
              className="flex min-h-6 items-center gap-1 text-[13px] text-brand-ink hover:underline"
            >
              View all <ChevronRight className="size-3.5" aria-hidden />
            </Link>
          }
        >
          <Async query={salaries} rows={5}>
            {(data) =>
              data.total === 0 ? (
                <EmptyState title="No salary received yet">Confirmed salaries appear here.</EmptyState>
              ) : (
                <Table min="min-w-[480px]" head={['User', 'Reference', 'Split', 'Amount']}>
                  {data.items.map((s) => (
                    <tr key={s.id} className="hover:bg-brand-wash">
                      <Cell>
                        <Person id={s.userId} name={s.userName} email={s.userEmail} />
                      </Cell>
                      <Cell>
                        <Link to={`/admin/salary/${s.id}`} className="num text-brand-ink hover:underline">
                          {s.reference}
                        </Link>
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
      </div>
    </div>
  );
}
