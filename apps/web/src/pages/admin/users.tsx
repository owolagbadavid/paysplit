import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { Eye, Users } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useParams, useSearchParams, Link } from 'react-router';
import { addCycles, parseMajor } from '@paysplit/core';
import { api, get, query as qs, queryClient } from '../../lib/api.ts';
import { date, dateTime, monthName, naira, ordinal, ruleValue, title } from '../../lib/format.ts';
import type { AdminOverview, AdminUser, AdminUserDetail, Page, PayIn, Transaction } from '../../lib/types.ts';
import { ProgressBar } from '../../ui/charts.tsx';
import {
  Async,
  Avatar,
  Button,
  EmptyState,
  FormError,
  Input,
  Loading,
  Modal,
  MoneyInput,
  Notice,
  PageHeader,
  Pagination,
  Panel,
  Rows,
  SearchInput,
  Segmented,
  Select,
  Status,
  Tile,
} from '../../ui/core.tsx';
import { ACCENTS, WalletGlyph } from '../../ui/forms.tsx';
import { TransactionTable } from '../../ui/tables.tsx';
import { Cell, Table } from './overview.tsx';

/** Review the person's account and rules, enter an amount, confirm. Nothing here claims the money arrived. */
export function PaySalary({ userId, onClose }: { userId: string | null; onClose: () => void }) {
  const navigate = useNavigate();
  const [raw, setRaw] = useState('');
  const [cycle, setCycle] = useState('');
  const [error, setError] = useState('');
  const query = useQuery({
    queryKey: ['admin', 'users', userId],
    queryFn: () => get<AdminUserDetail>(`/v1/admin/users/${userId}`),
    enabled: Boolean(userId),
  });
  const pay = useMutation({
    mutationFn: ({ amount, payCycle }: { amount: number; payCycle: string }) =>
      api<PayIn>('POST', '/v1/admin/pay-ins', { userId, amount, payCycle }),
    onSuccess: async (run) => {
      await queryClient.invalidateQueries({ queryKey: ['admin'] });
      onClose();
      await navigate(`/admin/pay-ins/${run.id}`);
    },
  });
  return (
    <Modal
      open={Boolean(userId)}
      onClose={onClose}
      title="Send a test salary"
      subtitle="Goes through the payment provider’s sandbox. No real money moves."
      width="max-w-xl"
    >
      <Async query={query} rows={4}>
        {(u) => {
          const active = u.rules.filter((r) => r.status === 'active');
          const chosen = cycle || u.suggestedPayCycle;
          const submit = () => {
            const value = raw.trim() ? parseMajor(raw) : u.profile.expectedSalary;
            const problem = !value || value < 10_000 ? 'Enter at least ₦100' : '';
            setError(problem);
            if (!problem) pay.mutate({ amount: value!, payCycle: chosen });
          };
          return (
            <div className="space-y-4">
              <Rows
                items={[
                  ['User', `${u.profile.firstName} ${u.profile.lastName}`],
                  [
                    'Salary account',
                    u.account?.accountNumber
                      ? `${u.account.bankName}, ${u.account.accountNumber}`
                      : 'Not ready',
                  ],
                ]}
              />
              {u.ineligibleReason ? (
                <Notice tone="warn" title="Not eligible">
                  {u.ineligibleReason}. Only a verified user with a salary account can receive a test salary.
                </Notice>
              ) : (
                <>
                  <div>
                    <h3 className="mb-1.5 text-[13px] font-medium">Active split rules</h3>
                    {active.length === 0 ? (
                      <Notice tone="warn">
                        No active rules. The salary will stay in the salary account.
                      </Notice>
                    ) : (
                      <ul className="divide-y rounded-xl border">
                        {active.map((r) => (
                          <li key={r.id} className="flex justify-between gap-3 px-4 py-2.5 text-[13px]">
                            <span>
                              {r.priority}. {r.name}{' '}
                              <span className="text-muted">to {r.destination.name}</span>
                            </span>
                            <span className="num font-medium">{ruleValue(r)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <MoneyInput
                      label="Salary amount"
                      placeholder={
                        u.profile.expectedSalary ? String(u.profile.expectedSalary / 100) : '600,000'
                      }
                      value={raw}
                      onChange={(e) => setRaw(e.target.value)}
                      error={error}
                      hint={u.profile.expectedSalary ? 'Leave blank to use their expected salary' : undefined}
                    />
                    <Select
                      label="Pay cycle"
                      value={chosen}
                      onChange={(e) => setCycle(e.target.value)}
                      hint="One automatic split per cycle"
                    >
                      {Array.from({ length: 6 }, (_, i) => addCycles(u.suggestedPayCycle, i - 1)).map((c) => (
                        <option key={c} value={c}>
                          {monthName(c)}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <FormError error={pay.error} />
                  <Button className="w-full" busy={pay.isPending} onClick={submit}>
                    Send test salary
                  </Button>
                </>
              )}
            </div>
          );
        }}
      </Async>
    </Modal>
  );
}

export function AdminUsers() {
  const [params, setParams] = useSearchParams();
  const verification = (params.get('verification') ?? '') as '' | 'verified' | 'unverified' | 'review';
  const q = params.get('q') ?? '';
  const page = Number(params.get('page')) || 1;
  const [paying, setPaying] = useState<string | null>(null);
  const patch = (changes: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries({ page: '', ...changes })) v ? next.set(k, v) : next.delete(k);
    setParams(next, { replace: true });
  };
  const overview = useQuery({
    queryKey: ['admin', 'overview'],
    queryFn: () => get<AdminOverview>('/v1/admin/overview'),
  });
  const list = useQuery({
    queryKey: ['admin', 'users', { q, verification, page }],
    queryFn: () => get<Page<AdminUser>>(`/v1/admin/users${qs({ q, verification, page, pageSize: 10 })}`),
    placeholderData: keepPreviousData,
  });
  return (
    <>
      <PageHeader title="Users" crumbs={[{ label: 'Dashboard', to: '/admin' }, { label: 'Manage Users' }]} />
      <Async query={overview} rows={1}>
        {(o) => (
          <div className="mb-5 grid gap-4 sm:grid-cols-3">
            <Tile label="Total Users" value={o.totalUsers} note="Registered users" />
            <Tile label="Verified Users" value={o.verifiedUsers} note="Identity and liveness passed" />
            <Tile
              label="Unverified Users"
              value={o.unverifiedUsers}
              note={`${o.pendingVerification} started verification`}
            />
          </div>
        )}
      </Async>
      <Panel
        flush
        title="All Users"
        actions={
          <>
            <SearchInput value={q} onChange={(v) => patch({ q: v })} label="Search name or email" />
            <Segmented
              label="Verification"
              value={verification}
              onChange={(v) => patch({ verification: v })}
              options={[
                ['', 'All'],
                ['verified', 'Verified'],
                ['unverified', 'Unverified'],
                ['review', 'In review'],
              ]}
            />
          </>
        }
      >
        <Async query={list} rows={6}>
          {(data) =>
            data.total === 0 ? (
              <EmptyState
                icon={<Users className="size-5" />}
                title={q || verification ? 'No matching users' : 'No users yet'}
              />
            ) : (
              <Table
                min="min-w-[1080px]"
                head={[
                  'User',
                  'Country',
                  'Date joined',
                  'Verification',
                  'Salary account',
                  'Total paid',
                  'Pay date',
                  'Expected salary',
                  <span className="block text-right">Action</span>,
                ]}
              >
                {data.items.map((u) => (
                  <tr key={u.id} className="hover:bg-brand-wash">
                    <Cell>
                      <Link to={`/admin/users/${u.id}`} className="font-medium hover:underline">
                        {u.name}
                      </Link>
                      <span className="block text-[12px] text-muted">{u.email}</span>
                    </Cell>
                    <Cell>{u.country ?? 'Not set'}</Cell>
                    <Cell className="whitespace-nowrap">{date(u.createdAt)}</Cell>
                    <Cell>
                      <Status value={u.kycStatus} />
                    </Cell>
                    <Cell className="num">
                      {u.accountMasked ? (
                        <>
                          {u.accountBank}
                          <span className="block text-[12px] text-muted">{u.accountMasked}</span>
                        </>
                      ) : (
                        <span className="text-muted">None</span>
                      )}
                    </Cell>
                    <Cell className="num">{naira(u.totalPaid)}</Cell>
                    <Cell>{u.salaryDay ? ordinal(u.salaryDay) : 'Not set'}</Cell>
                    <Cell className="num">{u.expectedSalary ? naira(u.expectedSalary) : 'Not set'}</Cell>
                    <Cell className="text-right whitespace-nowrap">
                      {u.ineligibleReason ? (
                        <span className="mr-2 text-[12px] text-muted">{u.ineligibleReason}</span>
                      ) : (
                        <Button size="sm" onClick={() => setPaying(u.id)}>
                          Pay salary
                        </Button>
                      )}
                      <Link
                        to={`/admin/users/${u.id}`}
                        aria-label={`Open ${u.name}`}
                        className="ml-1 inline-flex size-9 items-center justify-center rounded-lg hover:bg-white"
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
      {list.data && <Pagination {...list.data} noun="users" onPage={(p) => patch({ page: String(p) })} />}
      <PaySalary userId={paying} onClose={() => setPaying(null)} />
    </>
  );
}

const TABS = [
  ['transactions', 'Transactions'],
  ['splits', 'Split'],
  ['wallets', 'Wallets'],
  ['beneficiaries', 'Beneficiary'],
  ['profile', 'Profile & Verification'],
] as const;

/** Records an administrator's decision on a case the provider could not settle. */
function ReviewKyc({ user }: { user: AdminUserDetail }) {
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const review = useMutation({
    mutationFn: (decision: 'approve' | 'reject') =>
      api('POST', `/v1/admin/users/${user.profile.id}/kyc-review`, { decision, note }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin'] }),
  });
  const decide = (decision: 'approve' | 'reject') => {
    const problem = note.trim().length < 5 ? 'Say why in a few words' : '';
    setError(problem);
    if (!problem) review.mutate(decision);
  };
  return (
    <Panel title="Verification Review">
      <p className="text-[13px] text-muted">
        {user.kyc?.reason} The provider scored liveness {user.kyc?.livenessScore ?? 'nothing'} and the face
        match {user.kyc?.matchScore ?? 'nothing'} out of 100.
      </p>
      <div className="mt-4 space-y-4">
        <Input
          label="Note for the audit log"
          value={note}
          onChange={(e) => {
            setNote(e.target.value);
            setError('');
          }}
          error={error}
          maxLength={300}
          required
        />
        <FormError error={review.error} />
        <div className="flex flex-wrap gap-3">
          <Button
            busy={review.isPending && review.variables === 'approve'}
            disabled={review.isPending}
            onClick={() => decide('approve')}
          >
            Approve verification
          </Button>
          <Button
            variant="outline"
            busy={review.isPending && review.variables === 'reject'}
            disabled={review.isPending}
            onClick={() => decide('reject')}
          >
            Reject
          </Button>
        </div>
      </div>
    </Panel>
  );
}

function Transactions({ userId }: { userId: string }) {
  const [group, setGroup] = useState<'' | 'wallet' | 'beneficiary'>('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: ['admin', 'user-transactions', userId, group, q, page],
    queryFn: () =>
      get<Page<Transaction>>(`/v1/admin/users/${userId}/transactions${qs({ group, q, page, pageSize: 10 })}`),
    placeholderData: keepPreviousData,
  });
  return (
    <>
      <Panel
        flush
        title="Financial Activity"
        actions={
          <>
            <SearchInput value={q} onChange={setQ} />
            <Segmented
              label="Show"
              value={group}
              onChange={setGroup}
              options={[
                ['', 'All'],
                ['wallet', 'Wallet'],
                ['beneficiary', 'Beneficiary'],
              ]}
            />
          </>
        }
      >
        <Async query={list} rows={5}>
          {(data) =>
            data.total === 0 ? (
              <EmptyState title="No transactions" />
            ) : (
              <TransactionTable items={data.items} />
            )
          }
        </Async>
      </Panel>
      {list.data && list.data.total > 0 && <Pagination {...list.data} onPage={setPage} />}
    </>
  );
}

export function AdminUser() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find(([k]) => k === params.get('tab'))?.[0] ??
    'transactions') as (typeof TABS)[number][0];
  const [paying, setPaying] = useState(false);
  const query = useQuery({
    queryKey: ['admin', 'users', id],
    queryFn: () => get<AdminUserDetail>(`/v1/admin/users/${id}`),
  });
  if (query.isPending) return <Loading rows={8} />;
  return (
    <Async query={query}>
      {(u) => {
        const name = `${u.profile.firstName} ${u.profile.lastName}`;
        const active = u.rules.filter((r) => r.status === 'active');
        return (
          <>
            <PageHeader
              title="Users"
              crumbs={[
                { label: 'Dashboard', to: '/admin' },
                { label: 'Manage Users', to: '/admin/users' },
                { label: name },
              ]}
            />
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-4 rounded-card border bg-strip p-5">
                <div className="flex items-center gap-4">
                  <Avatar name={name} className="size-14 text-lg" />
                  <div>
                    <p className="flex flex-wrap items-center gap-2 text-lg font-semibold">
                      {name} <Status value={u.profile.kycStatus} />
                    </p>
                    <p className="text-[13px] text-muted">
                      {u.profile.email}. Country: {u.profile.countryName ?? 'not set'}. Joined{' '}
                      {date(u.profile.createdAt)}
                    </p>
                  </div>
                </div>
                {u.ineligibleReason ? (
                  <span className="text-[13px] text-muted">
                    Cannot receive a test salary: {u.ineligibleReason.toLowerCase()}
                  </span>
                ) : (
                  <Button onClick={() => setPaying(true)}>Pay salary</Button>
                )}
              </div>
              {u.kyc?.inReview && tab !== 'profile' && (
                <Notice title="This verification is waiting for a review">
                  <button
                    type="button"
                    className="underline"
                    onClick={() => setParams({ tab: 'profile' }, { replace: true })}
                  >
                    Review it
                  </button>
                </Notice>
              )}
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <Tile
                  label="Active Wallets"
                  value={u.wallets.length}
                  note={`Balance ${naira(u.wallets.reduce((s, w) => s + w.balance, 0))}`}
                />
                <Tile
                  label="Saved Beneficiaries"
                  value={u.beneficiaries.length}
                  note={`Across ${new Set(u.beneficiaries.map((b) => b.category)).size} categories`}
                />
                <Tile label="Active Split Rules" value={active.length} note={`${u.rules.length} in total`} />
                <Tile
                  label="Expected Salary Date"
                  value={u.profile.salaryDay ? `${ordinal(u.profile.salaryDay)} of month` : 'Not set'}
                />
              </div>
              <Segmented
                label="Section"
                value={tab}
                onChange={(t) => setParams({ tab: t }, { replace: true })}
                options={TABS}
              />
              {tab === 'transactions' && <Transactions userId={u.profile.id} />}
              {tab === 'splits' && (
                <>
                  <Panel flush title="All Split Rules">
                    {u.rules.length === 0 ? (
                      <EmptyState title="No split rules" />
                    ) : (
                      <Table
                        head={[
                          'Priority',
                          'Rule',
                          'Destination',
                          'Method',
                          'Status',
                          'Created',
                          'Allocated this month',
                        ]}
                      >
                        {u.rules.map((r) => (
                          <tr key={r.id}>
                            <Cell className="num">{r.priority}</Cell>
                            <Cell className="font-medium">{r.name}</Cell>
                            <Cell>
                              {r.destination.name}{' '}
                              <span className="text-muted">({r.destination.detail})</span>
                            </Cell>
                            <Cell className="num">{ruleValue(r)}</Cell>
                            <Cell>
                              <Status value={r.status} />
                            </Cell>
                            <Cell>{date(r.createdAt)}</Cell>
                            <Cell className="num">{naira(r.allocatedThisMonth)}</Cell>
                          </tr>
                        ))}
                      </Table>
                    )}
                  </Panel>
                  <Panel flush title="Split executions">
                    {u.splits.length === 0 ? (
                      <EmptyState title="No splits yet" />
                    ) : (
                      <Table
                        head={[
                          'Date',
                          'Trigger',
                          'Cycle',
                          'Salary',
                          'To wallets',
                          'To beneficiaries',
                          'Remaining',
                          'Status',
                        ]}
                      >
                        {u.splits.map((s) => (
                          <tr key={s.id}>
                            <Cell>
                              <Link
                                to={`/admin/salary/${s.salaryPaymentId}`}
                                className="text-brand-ink hover:underline"
                              >
                                {dateTime(s.createdAt)}
                              </Link>
                            </Cell>
                            <Cell>{s.trigger === 'manual' ? 'Run Now' : 'Automatic'}</Cell>
                            <Cell>{s.payCycle}</Cell>
                            <Cell className="num">{naira(s.salaryAmount)}</Cell>
                            <Cell className="num">{naira(s.toWallets)}</Cell>
                            <Cell className="num">{naira(s.toBeneficiaries)}</Cell>
                            <Cell className="num">{naira(s.remaining)}</Cell>
                            <Cell>
                              <Status value={s.status} />
                            </Cell>
                          </tr>
                        ))}
                      </Table>
                    )}
                  </Panel>
                </>
              )}
              {tab === 'wallets' &&
                (u.wallets.length === 0 ? (
                  <Panel>
                    <EmptyState title="No wallets created" />
                  </Panel>
                ) : (
                  <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                    {u.wallets.map((w) => {
                      const rule = u.rules.find((r) => r.destination.id === w.id);
                      return (
                        <div
                          key={w.id}
                          className="rounded-card p-5"
                          style={{ background: ACCENTS[w.accent]?.card }}
                        >
                          <div className="flex items-center gap-3">
                            <WalletGlyph wallet={w} className="size-11" />
                            <div className="flex-1">
                              <p className="font-semibold">{w.name}</p>
                              <p className="text-[12px] text-[#4b5563]">{title(w.category)}</p>
                            </div>
                            <p className="num text-lg">{naira(w.balance)}</p>
                          </div>
                          <div className="mt-5">
                            {w.targetAmount ? (
                              <ProgressBar
                                value={w.balance}
                                max={w.targetAmount}
                                label={`Target ${naira(w.targetAmount)}`}
                              />
                            ) : (
                              <p className="text-[12px] text-[#4b5563]">No target set</p>
                            )}
                          </div>
                          <p className="mt-4 flex items-center justify-between text-[12px]">
                            {rule ? `Rule: ${ruleValue(rule)}, priority ${rule.priority}` : 'No rule'}{' '}
                            {rule && <Status value={rule.status} />}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                ))}
              {tab === 'beneficiaries' && (
                <Panel flush title="All Beneficiaries">
                  {u.beneficiaries.length === 0 ? (
                    <EmptyState title="No beneficiaries saved" />
                  ) : (
                    <Table head={['Recipient', 'Bank', 'Account number', 'Category', 'Rule', 'Rule status']}>
                      {u.beneficiaries.map((b) => {
                        const rule = u.rules.find((r) => r.destination.id === b.id);
                        return (
                          <tr key={b.id}>
                            <Cell className="font-medium">{b.name}</Cell>
                            <Cell>{b.bankName}</Cell>
                            <Cell className="num">{b.accountNumberMasked}</Cell>
                            <Cell>{title(b.category)}</Cell>
                            <Cell className="num">
                              {rule ? `${ruleValue(rule)}, priority ${rule.priority}` : 'None'}
                            </Cell>
                            <Cell>{rule ? <Status value={rule.status} /> : null}</Cell>
                          </tr>
                        );
                      })}
                    </Table>
                  )}
                </Panel>
              )}
              {tab === 'profile' && (
                <div className="grid gap-4 lg:grid-cols-2">
                  <Panel title="Account Details">
                    {u.account ? (
                      <Rows
                        items={[
                          ['Status', <Status value={u.account.status} />],
                          ['Account Number', u.account.accountNumber ?? 'Not issued'],
                          ['Account Name', u.account.accountName ?? 'Not issued'],
                          ['Bank', u.account.bankName ?? 'Not issued'],
                          ['Balance', naira(u.account.balance)],
                          ...(u.account.failureReason
                            ? ([['Problem', u.account.failureReason]] as [string, string][])
                            : []),
                        ]}
                      />
                    ) : (
                      <EmptyState title="No salary account">
                        It is created when the user is verified.
                      </EmptyState>
                    )}
                  </Panel>
                  <Panel title="KYC Verification Checklist">
                    {u.kyc ? (
                      <Rows
                        items={[
                          [
                            'Identity document',
                            `${u.kyc.identityType.toUpperCase()} ${u.kyc.identityMasked}`,
                          ],
                          ['Identity check', <Status value={u.kyc.identityStatus} />],
                          [
                            'Checked',
                            u.kyc.identityCheckedAt ? dateTime(u.kyc.identityCheckedAt) : 'Not yet',
                          ],
                          ['Biometric selfie', <Status value={u.kyc.livenessStatus} />],
                          [
                            'Submitted',
                            u.kyc.livenessCheckedAt ? dateTime(u.kyc.livenessCheckedAt) : 'Not yet',
                          ],
                          ['Provider', title(u.kyc.provider)],
                          ...(u.kyc.reason ? ([['Reason', u.kyc.reason]] as [string, string][]) : []),
                        ]}
                      />
                    ) : (
                      <EmptyState title="Verification not started" />
                    )}
                  </Panel>
                  {u.kyc?.inReview && <ReviewKyc user={u} />}
                  <Panel title="Other Details">
                    <Rows
                      items={[
                        ['Phone Number', u.profile.phone ?? 'Not set'],
                        ['Email verified', u.profile.emailVerified ? 'Yes' : 'No'],
                        ['Employer', u.profile.employer ?? 'Not set'],
                        [
                          'Expected salary',
                          u.profile.expectedSalary ? naira(u.profile.expectedSalary) : 'Not set',
                        ],
                      ]}
                    />
                  </Panel>
                </div>
              )}
            </div>
            <PaySalary userId={paying ? u.profile.id : null} onClose={() => setPaying(false)} />
          </>
        );
      }}
    </Async>
  );
}
