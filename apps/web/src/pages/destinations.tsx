import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowRight,
  Eye,
  EyeOff,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Users,
  Wallet as WalletIcon,
} from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { parseMajor } from '@paysplit/core';
import { PageBody, VerificationNotice } from '../layouts/app.tsx';
import { api, ApiError, get, newKey, query as qs, refreshMoney } from '../lib/api.ts';
import { calendarDate, date, naira, ruleValue, title } from '../lib/format.ts';
import { useUser } from '../lib/session.ts';
import type {
  Beneficiary,
  BeneficiaryDetail,
  Dashboard,
  LinkedRule,
  Page,
  Transaction,
  Wallet,
  WalletDetail,
} from '../lib/types.ts';
import { ProgressBar } from '../ui/charts.tsx';
import {
  Async,
  Button,
  buttonClass,
  Confirm,
  CopyButton,
  cx,
  EmptyState,
  FormError,
  IconButton,
  Modal,
  MoneyInput,
  Notice,
  PageHeader,
  Pagination,
  Panel,
  Rows,
  SearchInput,
  Segmented,
  Status,
  Tile,
  useToast,
} from '../ui/core.tsx';
import {
  ACCENTS,
  BeneficiaryForm,
  CreateFlow,
  RuleForm,
  toEditable,
  WalletForm,
  WalletGlyph,
  type RuleTarget,
} from '../ui/forms.tsx';
import { TransactionDrawer, TransactionTable } from '../ui/tables.tsx';

/** Transactions for a set of filters, with search, tabs and paging of its own. */
function Activity({
  heading,
  filters,
  tabs,
  empty,
}: {
  heading: string;
  filters: Record<string, string>;
  tabs?: [string, string][];
  empty: string;
}) {
  const [tab, setTab] = useState(tabs?.[0]?.[0] ?? '');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ['transactions', filters, tab, q, page],
    queryFn: () =>
      get<Page<Transaction>>(`/v1/transactions${qs({ ...filters, type: tab, q, page, pageSize: 8 })}`),
    placeholderData: keepPreviousData,
  });
  return (
    <>
      <Panel
        flush
        title={heading}
        actions={
          <>
            <SearchInput
              value={q}
              onChange={(v) => {
                setQ(v);
                setPage(1);
              }}
            />
            {tabs && (
              <Segmented
                label="Show"
                value={tab}
                onChange={(v) => {
                  setTab(v);
                  setPage(1);
                }}
                options={tabs}
              />
            )}
          </>
        }
      >
        <Async query={list} rows={4}>
          {(data) =>
            data.total === 0 ? (
              <EmptyState title="No activity yet">{empty}</EmptyState>
            ) : (
              <TransactionTable
                items={data.items}
                onOpen={setOpen}
                side={filters.beneficiaryId ? 'salary' : 'wallet'}
              />
            )
          }
        </Async>
      </Panel>
      {list.data && list.data.total > 0 && (
        <Pagination {...list.data} noun="activity entries" onPage={setPage} />
      )}
      <TransactionDrawer id={open} onClose={() => setOpen(null)} />
    </>
  );
}

function WalletCard({ wallet }: { wallet: Wallet }) {
  return (
    <article className="flex flex-col rounded-card p-5" style={{ background: ACCENTS[wallet.accent]?.card }}>
      <div className="flex items-center gap-3">
        <WalletGlyph wallet={wallet} className="size-11" />
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-semibold">{wallet.name}</h3>
          <p className="text-[12px] text-[#4b5563]">{title(wallet.category)}</p>
        </div>
        <p className="num text-xl">{naira(wallet.balance)}</p>
      </div>
      <div className="mt-6 min-h-10">
        {wallet.targetAmount ? (
          <ProgressBar
            value={wallet.balance}
            max={wallet.targetAmount}
            label={`Target ${naira(wallet.targetAmount)}`}
          />
        ) : (
          <p className="text-[12px] text-[#4b5563]">No target set</p>
        )}
      </div>
      <div className="mt-6 flex items-center justify-between text-[12px]">
        <span className="text-[#4b5563]">Created {date(wallet.createdAt)}</span>
        <Link
          to={`/destinations/wallets/${wallet.id}`}
          className="flex min-h-6 items-center gap-1 font-semibold hover:underline"
          aria-label={`View ${wallet.name}`}
        >
          View wallet <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      </div>
    </article>
  );
}

export function DestinationsPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'beneficiary' ? 'beneficiary' : 'wallet';
  const [creating, setCreating] = useState<'wallet' | 'beneficiary' | null>(null);
  return (
    <PageBody>
      <PageHeader
        title="Destinations"
        crumbs={[{ label: 'Dashboard', to: '/dashboard' }, { label: 'Destinations' }]}
      />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Segmented
          label="Destination type"
          value={tab}
          onChange={(t) => setParams(t === 'wallet' ? {} : { tab: t }, { replace: true })}
          options={[
            ['wallet', 'Wallets'],
            ['beneficiary', 'Beneficiary'],
          ]}
        />
        <Button icon={<Plus className="size-4" aria-hidden />} onClick={() => setCreating(tab)}>
          {tab === 'wallet' ? 'Create Wallet' : 'Add beneficiary'}
        </Button>
      </div>
      <div className="space-y-5">
        <VerificationNotice />
        {tab === 'wallet' ? (
          <Wallets onCreate={() => setCreating('wallet')} />
        ) : (
          <Beneficiaries onCreate={() => setCreating('beneficiary')} />
        )}
      </div>
      <CreateFlow kind={creating} onClose={() => setCreating(null)} />
    </PageBody>
  );
}

function Wallets({ onCreate }: { onCreate: () => void }) {
  const query = useQuery({ queryKey: ['wallets'], queryFn: () => get<{ items: Wallet[] }>('/v1/wallets') });
  return (
    <>
      <Async query={query} rows={3}>
        {({ items }) =>
          items.length === 0 ? (
            <Panel>
              <EmptyState
                icon={<WalletIcon className="size-5" />}
                title="No wallets created"
                action={<Button onClick={onCreate}>Create your first wallet</Button>}
              >
                A wallet holds money for one purpose, such as savings or rent. Wallets are filled by your
                split rules.
              </EmptyState>
            </Panel>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {items.map((w) => (
                <WalletCard key={w.id} wallet={w} />
              ))}
            </div>
          )
        }
      </Async>
      <Activity
        heading="All Wallet Activity"
        filters={{ group: 'wallet' }}
        tabs={[
          ['', 'All'],
          ['wallet_allocation', 'Money in'],
          ['wallet_to_salary', 'Money out'],
        ]}
        empty="Allocations and moves appear here."
      />
    </>
  );
}

function Beneficiaries({ onCreate }: { onCreate: () => void }) {
  const query = useQuery({
    queryKey: ['beneficiaries'],
    queryFn: () => get<{ items: Beneficiary[] }>('/v1/beneficiaries'),
  });
  const dashboard = useQuery({ queryKey: ['dashboard'], queryFn: () => get<Dashboard>('/v1/dashboard') });
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'all' | 'active' | 'paused'>('all');
  const [editing, setEditing] = useState<Beneficiary | null>(null);
  const [removing, setRemoving] = useState<Beneficiary | null>(null);
  const next = dashboard.data?.expected?.date;
  return (
    <>
      <Panel
        flush
        title="All Beneficiaries"
        actions={
          <>
            <SearchInput value={q} onChange={setQ} />
            <Segmented
              label="Rule status"
              value={status}
              onChange={setStatus}
              options={[
                ['all', 'All'],
                ['active', 'Active'],
                ['paused', 'Paused'],
              ]}
            />
          </>
        }
      >
        <Async query={query} rows={4}>
          {({ items }) => {
            const shown = items.filter(
              (b) =>
                (status === 'all' || b.rule?.status === status) &&
                `${b.name} ${b.bankName} ${b.accountName}`.toLowerCase().includes(q.toLowerCase()),
            );
            if (items.length === 0) {
              return (
                <EmptyState
                  icon={<Users className="size-5" />}
                  title="No beneficiaries saved"
                  action={<Button onClick={onCreate}>Add your first beneficiary</Button>}
                >
                  Save the people and businesses you pay, then add a rule to pay them from each salary.
                </EmptyState>
              );
            }
            if (shown.length === 0)
              return <EmptyState title="No matches">Try another name or filter.</EmptyState>;
            return (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-[13px]">
                  <thead className="text-muted">
                    <tr className="border-b">
                      {[
                        'Recipient / Entity',
                        'Bank Name',
                        'Account Number',
                        'Category',
                        'Next split',
                        'Rule',
                      ].map((h) => (
                        <th key={h} className="px-4 py-3 font-normal">
                          {h}
                        </th>
                      ))}
                      <th className="px-4 py-3 text-right font-normal">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {shown.map((b) => (
                      <tr key={b.id} className="hover:bg-brand-wash">
                        <td className="px-4 py-3">
                          <Link
                            to={`/destinations/beneficiaries/${b.id}`}
                            className="font-medium hover:underline"
                          >
                            {b.name}
                          </Link>
                        </td>
                        <td className="px-4 py-3">{b.bankName}</td>
                        <td className="num px-4 py-3">{b.accountNumberMasked}</td>
                        <td className="px-4 py-3">
                          <span className="rounded-md border px-2 py-0.5">{title(b.category)}</span>
                        </td>
                        <td className="px-4 py-3 font-medium">
                          {b.rule?.status === 'active' && next ? calendarDate(next) : 'Not scheduled'}
                        </td>
                        <td className="px-4 py-3">
                          {b.rule ? (
                            <Status value={b.rule.status} />
                          ) : (
                            <span className="text-muted">None</span>
                          )}
                        </td>
                        <td className="px-2 py-1 text-right whitespace-nowrap">
                          <Link
                            to={`/destinations/beneficiaries/${b.id}`}
                            aria-label={`View ${b.name}`}
                            className="inline-flex size-9 items-center justify-center rounded-lg hover:bg-white"
                          >
                            <Eye className="size-4" />
                          </Link>
                          <IconButton label={`Edit ${b.name}`} onClick={() => setEditing(b)}>
                            <Pencil className="size-4" />
                          </IconButton>
                          <IconButton
                            label={`Remove ${b.name}`}
                            className="text-bad"
                            onClick={() => setRemoving(b)}
                          >
                            <Trash2 className="size-4" />
                          </IconButton>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          }}
        </Async>
      </Panel>
      <Modal open={Boolean(editing)} onClose={() => setEditing(null)} title="Edit beneficiary">
        {editing && <BeneficiaryForm beneficiary={editing} onSaved={() => setEditing(null)} />}
      </Modal>
      <RemoveBeneficiary beneficiary={removing} onClose={() => setRemoving(null)} />
    </>
  );
}

function RemoveBeneficiary({
  beneficiary,
  onClose,
  onRemoved,
}: {
  beneficiary: { id: string; name: string } | null;
  onClose: () => void;
  onRemoved?: () => void;
}) {
  const remove = useMutation({
    mutationFn: () => api('DELETE', `/v1/beneficiaries/${beneficiary!.id}`),
    onSuccess: async () => {
      onClose();
      onRemoved?.();
      await refreshMoney();
    },
  });
  return (
    <Confirm
      open={Boolean(beneficiary)}
      onClose={onClose}
      onConfirm={() => remove.mutate()}
      busy={remove.isPending}
      error={remove.error}
      danger
      title={`Remove ${beneficiary?.name ?? ''}?`}
      confirmLabel="Remove"
    >
      Its split rule is deleted too. Past transfers and receipts stay in your history.
    </Confirm>
  );
}

function LinkedRuleCard({
  rule,
  target,
  name,
}: {
  rule: LinkedRule | null;
  target: RuleTarget;
  name: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border bg-white p-4">
      <h2 className="text-[13px] text-muted">Linked Rule</h2>
      {rule ? (
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="flex items-center gap-2 font-semibold">
              {ruleValue(rule)} <Status value={rule.status} />
            </p>
            <p className="text-[12px] text-muted">
              {rule.name}, priority {rule.priority}. Last modified {date(rule.updatedAt)}
            </p>
          </div>
          <Button
            variant="brandOutline"
            size="sm"
            icon={<RefreshCw className="size-3.5" aria-hidden />}
            onClick={() => setOpen(true)}
          >
            Reconfigure Rule
          </Button>
        </div>
      ) : (
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <p className="text-[13px]">No rule yet. Add one to fund this from your salary.</p>
          <Button size="sm" onClick={() => setOpen(true)}>
            Create Rule
          </Button>
        </div>
      )}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={rule ? 'Reconfigure Split Rule' : 'Create Split Rule'}
      >
        {open && (
          <RuleForm
            {...(rule ? { rule: toEditable(rule, name, target.type) } : { target })}
            onDone={() => setOpen(false)}
          />
        )}
      </Modal>
    </div>
  );
}

function MoveModal({ wallet, open, onClose }: { wallet: WalletDetail; open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [raw, setRaw] = useState('');
  const [error, setError] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [key, setKey] = useState(newKey);
  const amount = parseMajor(raw) ?? 0;
  const done = () => {
    setRaw('');
    setReviewing(false);
    setKey(newKey());
    onClose();
  };
  const move = useMutation({
    mutationFn: () => api('POST', `/v1/wallets/${wallet.id}/move`, { amount }, { 'Idempotency-Key': key }),
    onSuccess: async () => {
      toast(`${naira(amount)} moved to your salary account`);
      done();
      await refreshMoney();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) setKey(newKey());
    },
  });
  return (
    <Modal
      open={open}
      onClose={done}
      title="Move to Salary Account"
      subtitle={`${naira(wallet.balance)} available in ${wallet.name}`}
      width="max-w-md"
    >
      {reviewing ? (
        <div className="space-y-4">
          <Rows
            items={[
              ['From', `${wallet.name} (wallet)`],
              ['To', 'Your salary account'],
              ['Amount', naira(amount)],
              ['Fee', 'Free'],
            ]}
          />
          <Notice>Money you move back is not split again automatically.</Notice>
          <FormError error={move.error} />
          <div className="grid grid-cols-2 gap-3">
            <Button variant="outline" onClick={() => setReviewing(false)}>
              Edit
            </Button>
            <Button busy={move.isPending} onClick={() => move.mutate()}>
              Confirm move
            </Button>
          </div>
        </div>
      ) : (
        <form
          noValidate
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            const problem =
              amount <= 0
                ? 'Enter an amount above zero'
                : amount > wallet.balance
                  ? `You have ${naira(wallet.balance)} available`
                  : '';
            setError(problem);
            if (!problem) setReviewing(true);
          }}
        >
          <MoneyInput
            label="Amount"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            error={error}
            autoFocus
            required
          />
          <Button variant="ghost" size="sm" onClick={() => setRaw(String(wallet.balance / 100))}>
            Move everything
          </Button>
          <Button type="submit" className="w-full">
            Continue
          </Button>
        </form>
      )}
    </Modal>
  );
}

export function WalletPage() {
  const { id } = useParams();
  const user = useUser();
  const navigate = useNavigate();
  const [panel, setPanel] = useState<'edit' | 'move' | 'remove' | null>(null);
  const query = useQuery({
    queryKey: ['wallets', id],
    queryFn: () => get<WalletDetail>(`/v1/wallets/${id}`),
  });
  const remove = useMutation({
    mutationFn: () => api('DELETE', `/v1/wallets/${id}`),
    onSuccess: async () => {
      await navigate('/destinations');
      await refreshMoney();
    },
  });
  const close = () => setPanel(null);
  return (
    <PageBody>
      <PageHeader
        title={query.data?.name ?? 'Wallet'}
        crumbs={[
          { label: 'Dashboard', to: '/dashboard' },
          { label: 'Destinations', to: '/destinations' },
          { label: query.data?.name ?? 'Wallet' },
        ]}
      />
      <Async query={query} rows={6}>
        {(w) => (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Link to="/destinations" className="flex min-h-6 items-center gap-3 font-semibold">
                <ArrowLeft className="size-4" aria-hidden />
                <WalletGlyph wallet={w} /> {title(w.category)} wallet
              </Link>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  icon={<Pencil className="size-3.5" aria-hidden />}
                  onClick={() => setPanel('edit')}
                >
                  Edit Wallet
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  icon={<Trash2 className="size-3.5" aria-hidden />}
                  onClick={() => setPanel('remove')}
                >
                  Remove
                </Button>
                <Button
                  size="sm"
                  disabled={w.balance === 0 || user.kycStatus !== 'approved'}
                  onClick={() => setPanel('move')}
                >
                  Move to Salary Account
                </Button>
              </div>
            </div>
            {w.description && <p className="text-[13px] text-muted">{w.description}</p>}
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <Tile label="Available Balance" value={naira(w.balance)} note="Available in wallet" />
              <Tile label="Total Allocated" value={naira(w.totalAllocated)} note="Cumulative salary split" />
              <Tile
                label="Total Moved back"
                value={naira(w.totalMoved)}
                note="Moved to your salary account"
              />
              <div className="tile flex flex-col justify-between p-4">
                <p className="text-[13px] text-[#3a4450]">Goal Progress Target</p>
                {w.targetAmount ? (
                  <ProgressBar
                    value={w.balance}
                    max={w.targetAmount}
                    label={`Target ${naira(w.targetAmount)}`}
                  />
                ) : (
                  <p className="text-[13px] text-muted">No target set. Edit the wallet to add one.</p>
                )}
              </div>
            </div>
            <LinkedRuleCard rule={w.rule} target={{ type: 'wallet', id: w.id }} name={w.name} />
            <Activity
              heading="Wallet Transaction History"
              filters={{ walletId: w.id }}
              tabs={[
                ['', 'All'],
                ['wallet_allocation', 'Allocated'],
                ['wallet_to_salary', 'Moved'],
              ]}
              empty="Allocations to this wallet appear here."
            />
            <Modal open={panel === 'edit'} onClose={close} title="Edit Wallet">
              <WalletForm wallet={w} onSaved={close} />
            </Modal>
            <MoveModal wallet={w} open={panel === 'move'} onClose={close} />
            <Confirm
              open={panel === 'remove'}
              onClose={close}
              onConfirm={() => remove.mutate()}
              busy={remove.isPending}
              error={remove.error}
              danger
              title={`Remove ${w.name}?`}
              confirmLabel="Remove wallet"
            >
              {w.balance > 0
                ? 'This wallet still holds money. Move it to your salary account first.'
                : 'Its split rule is deleted too. Its history stays in your records.'}
            </Confirm>
          </div>
        )}
      </Async>
    </PageBody>
  );
}

export function BeneficiaryPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [reveal, setReveal] = useState(false);
  const [panel, setPanel] = useState<'edit' | 'remove' | null>(null);
  const query = useQuery({
    queryKey: ['beneficiaries', id],
    queryFn: () => get<BeneficiaryDetail>(`/v1/beneficiaries/${id}`),
  });
  const full = useQuery({
    queryKey: ['beneficiaries', id, 'full'],
    queryFn: () => get<BeneficiaryDetail>(`/v1/beneficiaries/${id}?reveal=true`),
    enabled: reveal,
    gcTime: 0,
  });
  return (
    <PageBody>
      <PageHeader
        title={query.data?.name ?? 'Beneficiary'}
        crumbs={[
          { label: 'Dashboard', to: '/dashboard' },
          { label: 'Destinations', to: '/destinations?tab=beneficiary' },
          { label: query.data?.name ?? 'Beneficiary' },
        ]}
      />
      <Async query={query} rows={6}>
        {(b) => {
          const number = reveal ? full.data?.accountNumber : null;
          return (
            <>
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <Link to="/destinations?tab=beneficiary" className={cx(buttonClass('outline', 'sm'))}>
                  <ArrowLeft className="size-4" aria-hidden /> Back
                </Link>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    icon={<Pencil className="size-3.5" aria-hidden />}
                    onClick={() => setPanel('edit')}
                  >
                    Edit
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    icon={<Trash2 className="size-3.5" aria-hidden />}
                    onClick={() => setPanel('remove')}
                  >
                    Remove
                  </Button>
                </div>
              </div>
              <div className="grid gap-4 xl:grid-cols-[360px_1fr]">
                <div className="space-y-4">
                  <Tile label="Total Sent" value={naira(b.totalSent)} note="Cumulative salary split" />
                  <LinkedRuleCard rule={b.rule} target={{ type: 'beneficiary', id: b.id }} name={b.name} />
                  <div className="rounded-xl border bg-white p-4">
                    <div className="flex items-start justify-between">
                      <div>
                        <p className="text-[13px] text-muted">Account Number</p>
                        <p className="num text-[22px] font-semibold tracking-wide">
                          {number ?? b.accountNumberMasked}
                        </p>
                      </div>
                      <div className="flex">
                        {number && <CopyButton value={number} label="Copy account number" />}
                        <IconButton
                          label={reveal ? 'Hide account number' : 'Show account number'}
                          onClick={() => setReveal(!reveal)}
                        >
                          {reveal ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                        </IconButton>
                      </div>
                    </div>
                    <Rows
                      items={[
                        ['Account Name', b.accountName],
                        ['Bank Name', b.bankName],
                        ['Category', title(b.category)],
                        ['Narration', b.narration ?? 'None'],
                        ['Date added', date(b.createdAt)],
                      ]}
                    />
                  </div>
                </div>
                <div>
                  <Activity
                    heading="Transfer History"
                    filters={{ beneficiaryId: b.id }}
                    empty="Transfers to this beneficiary appear here."
                  />
                </div>
              </div>
              <Modal open={panel === 'edit'} onClose={() => setPanel(null)} title="Edit beneficiary">
                <BeneficiaryForm beneficiary={b} onSaved={() => setPanel(null)} />
              </Modal>
              <RemoveBeneficiary
                beneficiary={panel === 'remove' ? b : null}
                onClose={() => setPanel(null)}
                onRemoved={() => void navigate('/destinations?tab=beneficiary')}
              />
            </>
          );
        }}
      </Async>
    </PageBody>
  );
}
