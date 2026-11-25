import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { Pause, Pencil, Play, Plus, Split as SplitIcon, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { PageBody, VerificationNotice } from '../layouts/app.tsx';
import { api, get, query as qs, refreshMoney } from '../lib/api.ts';
import { calendarDate, date, dateTime, naira, ruleValue, skipText } from '../lib/format.ts';
import { useUser } from '../lib/session.ts';
import type { Dashboard, Page, Rule, RuleDetail, RulesOverview, Split } from '../lib/types.ts';
import { AllocationBar } from '../ui/charts.tsx';
import {
  Async,
  Badge,
  Button,
  Confirm,
  EmptyState,
  IconButton,
  Modal,
  Notice,
  PageHeader,
  Pagination,
  Panel,
  Rows,
  SearchInput,
  Segmented,
  Status,
  useToast,
} from '../ui/core.tsx';
import { RuleForm } from '../ui/forms.tsx';
import { RunNow } from '../ui/run-now.tsx';

function Baseline({ data, expected }: { data: RulesOverview; expected: Dashboard['expected'] }) {
  const { baseline, projection, rules } = data;
  const byId = new Map(rules.map((r) => [r.id, r]));
  const skipped = projection.allocations.filter((a) => a.skipReason);
  const percent = baseline.amount ? Math.round((projection.totalAllocated / baseline.amount) * 100) : 0;
  return (
    <section aria-label="Salary baseline" className="tile rounded-card border p-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[13px] text-[#3a4450]">Monthly Salary Baseline</p>
          <p className="num text-[24px] font-semibold tracking-tight">
            {baseline.amount ? naira(baseline.amount) : 'Not set'}
          </p>
          <p className="text-[12px] text-muted">
            {baseline.source === 'expected'
              ? 'Your expected salary'
              : baseline.source === 'last_salary'
                ? 'Your last confirmed salary'
                : 'Add your expected salary in settings to see a projection'}
            {expected &&
              `. Next split expected ${calendarDate(expected.date)}, once your salary is confirmed.`}
          </p>
        </div>
        <dl className="flex gap-6 text-right">
          <div>
            <dt className="text-[12px] text-muted">Total Allocated</dt>
            <dd className="num font-semibold">{naira(projection.totalAllocated)}</dd>
          </div>
          <div>
            <dt className="text-[12px] text-muted">Salary Remainder</dt>
            <dd className="num font-semibold text-good">{naira(projection.remainder)}</dd>
          </div>
        </dl>
      </div>
      <p className="mt-4 mb-2 text-[13px]">
        Allocation progress <span className="font-semibold">{percent}% of salary</span>
      </p>
      <AllocationBar
        total={baseline.amount}
        parts={projection.allocations
          .filter((a) => a.allocated > 0)
          .map((a) => ({ label: byId.get(a.ruleId)?.destination.name ?? 'Rule', value: a.allocated }))}
        remainderLabel="Stays in salary account"
      />
      {skipped.length > 0 && (
        <div className="mt-4">
          <Notice tone="warn" title="Some rules would be skipped at this salary">
            {skipped
              .map(
                (a) =>
                  `${byId.get(a.ruleId)?.name}: ${skipText(a.skipReason).toLowerCase()} (needs ${naira(a.requested)})`,
              )
              .join('. ')}
            .
          </Notice>
        </div>
      )}
    </section>
  );
}

function RuleDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const query = useQuery({
    queryKey: ['rules', id],
    queryFn: () => get<RuleDetail>(`/v1/rules/${id}`),
    enabled: Boolean(id),
  });
  return (
    <Modal
      open={Boolean(id)}
      onClose={onClose}
      title={query.data?.name ?? 'Split rule'}
      side="right"
      width="max-w-md"
    >
      <Async query={query} rows={4}>
        {(r) => (
          <>
            {r.blockedReason && <Notice tone="warn">{r.blockedReason}</Notice>}
            <Rows
              items={[
                ['Status', <Status value={r.status} />],
                ['Destination', `${r.destination.name} (${r.destination.detail})`],
                ['Method', r.method === 'fixed' ? 'Fixed amount' : 'Percentage of salary'],
                ['Value', ruleValue(r)],
                ['Priority', `${r.priority} of 10`],
                ['Created', dateTime(r.createdAt)],
                ['Last changed', dateTime(r.updatedAt)],
              ]}
            />
            <h3 className="mt-4 mb-1 font-semibold">Execution history</h3>
            {r.history.length === 0 ? (
              <p className="text-[13px] text-muted">This rule has not run yet.</p>
            ) : (
              <ul className="divide-y">
                {r.history.map((h) => (
                  <li
                    key={h.executionId}
                    className="flex items-center justify-between gap-3 py-2.5 text-[13px]"
                  >
                    <span>
                      <Link
                        to={`/splits/${h.executionId}`}
                        className="font-medium text-brand-ink hover:underline"
                      >
                        {date(h.createdAt)}
                      </Link>
                      <span className="block text-[12px] text-muted">
                        {h.skipReason
                          ? skipText(h.skipReason)
                          : `${naira(h.allocated)} of ${naira(h.requested)}`}
                      </span>
                    </span>
                    <Status value={h.status} />
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Async>
    </Modal>
  );
}

function RulesTab({
  data,
  onEdit,
  onOpen,
}: {
  data: RulesOverview;
  onEdit: (rule: Rule) => void;
  onOpen: (id: string) => void;
}) {
  const toast = useToast();
  const user = useUser();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'all' | 'active' | 'paused' | 'draft'>('all');
  const [deleting, setDeleting] = useState<Rule | null>(null);
  const act = useMutation({
    mutationFn: ({ rule, action }: { rule: Rule; action: 'pause' | 'resume' | 'delete' }) =>
      action === 'delete'
        ? api('DELETE', `/v1/rules/${rule.id}`)
        : api('POST', `/v1/rules/${rule.id}/${action}`),
    onSuccess: async (_, { rule, action }) => {
      toast(`${rule.name} ${action === 'delete' ? 'deleted' : action === 'pause' ? 'paused' : 'resumed'}`);
      setDeleting(null);
      await refreshMoney();
    },
    onError: (e, { action }) => action !== 'delete' && toast((e as Error).message, 'bad'),
  });
  const shown = data.rules.filter(
    (r) =>
      (status === 'all' || r.status === status) &&
      `${r.name} ${r.destination.name}`.toLowerCase().includes(q.toLowerCase()),
  );
  return (
    <>
      <Panel
        flush
        title="All Salary Rules"
        actions={
          <>
            <SearchInput value={q} onChange={setQ} />
            <Segmented
              label="Status"
              value={status}
              onChange={setStatus}
              options={[
                ['all', 'All'],
                ['active', 'Active'],
                ['paused', 'Paused'],
                ['draft', 'Draft'],
              ]}
            />
          </>
        }
      >
        {data.rules.length === 0 ? (
          <EmptyState icon={<SplitIcon className="size-5" />} title="No split rules created">
            A rule sends part of each salary to one wallet or beneficiary. Create one to start splitting.
          </EmptyState>
        ) : shown.length === 0 ? (
          <EmptyState title="No matches">Try another name or filter.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-left text-[13px]">
              <thead className="text-muted">
                <tr className="border-b">
                  {[
                    'Priority',
                    'Rule Name',
                    'Destination',
                    'Method',
                    'Status',
                    'Date Created',
                    'Allocated This Month',
                  ].map((h) => (
                    <th key={h} className="px-4 py-3 font-normal">
                      {h}
                    </th>
                  ))}
                  <th className="px-4 py-3 text-right font-normal">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {shown.map((r) => (
                  <tr key={r.id} className="hover:bg-brand-wash">
                    <td className="num px-4 py-3">{r.priority}</td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => onOpen(r.id)}
                        className="min-h-6 text-left font-medium hover:underline"
                      >
                        {r.name}
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      {r.destination.name} <span className="text-muted">({r.destination.detail})</span>
                    </td>
                    <td className="num px-4 py-3">{ruleValue(r)}</td>
                    <td className="px-4 py-3">
                      {r.blockedReason ? (
                        <Badge tone="warn">Needs verification</Badge>
                      ) : (
                        <Status value={r.status} />
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">{date(r.createdAt)}</td>
                    <td className="num px-4 py-3 font-medium">{naira(r.allocatedThisMonth)}</td>
                    <td className="px-2 py-1 text-right whitespace-nowrap">
                      {r.status === 'active' && (
                        <IconButton
                          label={`Pause ${r.name}`}
                          onClick={() => act.mutate({ rule: r, action: 'pause' })}
                        >
                          <Pause className="size-4" />
                        </IconButton>
                      )}
                      {r.status === 'paused' && (
                        <IconButton
                          label={`Resume ${r.name}`}
                          disabled={user.kycStatus !== 'approved'}
                          onClick={() => act.mutate({ rule: r, action: 'resume' })}
                        >
                          <Play className="size-4" />
                        </IconButton>
                      )}
                      <IconButton
                        label={r.status === 'draft' ? `Review and activate ${r.name}` : `Edit ${r.name}`}
                        onClick={() => onEdit(r)}
                      >
                        <Pencil className="size-4" />
                      </IconButton>
                      <IconButton
                        label={`Delete ${r.name}`}
                        className="text-bad"
                        onClick={() => setDeleting(r)}
                      >
                        <Trash2 className="size-4" />
                      </IconButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <p className="px-3 py-2.5 text-[13px] text-muted">
        Showing {shown.length} of {data.rules.length} rules, in the order they run. Equal priorities run
        oldest first.
      </p>
      <Confirm
        open={Boolean(deleting)}
        onClose={() => {
          setDeleting(null);
          act.reset();
        }}
        onConfirm={() => act.mutate({ rule: deleting!, action: 'delete' })}
        busy={act.isPending}
        error={act.error}
        danger
        title={`Delete ${deleting?.name ?? ''}?`}
        confirmLabel="Delete rule"
      >
        It will not run again. Its past splits and transactions stay in your history.
      </Confirm>
    </>
  );
}

function HistoryTab() {
  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: ['splits', 'list', page],
    queryFn: () => get<Page<Split>>(`/v1/splits${qs({ page, pageSize: 10 })}`),
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
  });
  return (
    <>
      <Panel flush title="Split History">
        <Async query={list} rows={5}>
          {(data) =>
            data.total === 0 ? (
              <EmptyState icon={<SplitIcon className="size-5" />} title="No splits yet">
                Each time your rules run, the result appears here with every allocation.
              </EmptyState>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[820px] text-left text-[13px]">
                  <thead className="text-muted">
                    <tr className="border-b">
                      {[
                        'Date',
                        'Trigger',
                        'Salary',
                        'To wallets',
                        'To beneficiaries',
                        'Remaining',
                        'Status',
                      ].map((h) => (
                        <th key={h} className="px-4 py-3 font-normal">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="num divide-y">
                    {data.items.map((s) => (
                      <tr key={s.id} className="hover:bg-brand-wash">
                        <td className="px-4 py-3">
                          <Link to={`/splits/${s.id}`} className="font-medium text-brand-ink hover:underline">
                            {dateTime(s.createdAt)}
                          </Link>
                          <span className="block text-[12px] text-muted">{s.reference}</span>
                        </td>
                        <td className="px-4 py-3">{s.trigger === 'manual' ? 'Run Now' : 'Automatic'}</td>
                        <td className="px-4 py-3">{naira(s.salaryAmount)}</td>
                        <td className="px-4 py-3">{naira(s.toWallets)}</td>
                        <td className="px-4 py-3">{naira(s.toBeneficiaries)}</td>
                        <td className="px-4 py-3">{naira(s.remaining)}</td>
                        <td className="px-4 py-3">
                          <Status value={s.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          }
        </Async>
      </Panel>
      {list.data && list.data.total > 0 && <Pagination {...list.data} noun="splits" onPage={setPage} />}
    </>
  );
}

export function RulesPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'history' ? 'history' : 'rules';
  const query = useQuery({ queryKey: ['rules'], queryFn: () => get<RulesOverview>('/v1/rules') });
  const dashboard = useQuery({ queryKey: ['dashboard'], queryFn: () => get<Dashboard>('/v1/dashboard') });
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Rule | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  return (
    <PageBody>
      <PageHeader
        title="Split Rules"
        crumbs={[{ label: 'Dashboard', to: '/dashboard' }, { label: 'Split Rules' }]}
        actions={
          <>
            {dashboard.data?.runNowAvailable && (
              <Button
                variant="brandOutline"
                icon={<Play className="size-4" aria-hidden />}
                onClick={() => setRunning(true)}
              >
                Run Now
              </Button>
            )}
            <Button icon={<Plus className="size-4" aria-hidden />} onClick={() => setCreating(true)}>
              Add New Rule
            </Button>
          </>
        }
      />
      <div className="space-y-4">
        <VerificationNotice />
        <Async query={query} rows={6}>
          {(data) => (
            <div className="space-y-4">
              <Baseline data={data} expected={dashboard.data?.expected ?? null} />
              <Segmented
                label="View"
                value={tab}
                onChange={(t) => setParams(t === 'rules' ? {} : { tab: t }, { replace: true })}
                options={[
                  ['rules', 'Rules'],
                  ['history', 'Split history'],
                ]}
              />
              <div>
                {tab === 'rules' ? (
                  <RulesTab data={data} onEdit={setEditing} onOpen={setOpened} />
                ) : (
                  <HistoryTab />
                )}
              </div>
            </div>
          )}
        </Async>
      </div>
      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="Create Split Rule"
        subtitle="Configure automatic distribution of incoming salary"
      >
        <RuleForm
          onDone={() => setCreating(false)}
          onExisting={(id) => {
            setCreating(false);
            setOpened(id);
          }}
        />
      </Modal>
      <Modal open={Boolean(editing)} onClose={() => setEditing(null)} title="Reconfigure Split Rule">
        {editing && (
          <RuleForm
            rule={{
              ...editing,
              destinationName: editing.destination.name,
              destinationType: editing.destination.type,
            }}
            onDone={() => setEditing(null)}
          />
        )}
      </Modal>
      <RuleDrawer id={opened} onClose={() => setOpened(null)} />
      <RunNow open={running} onClose={() => setRunning(false)} />
    </PageBody>
  );
}
