import { useMutation, useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  Bell,
  BriefcaseBusiness,
  Check,
  ChevronRight,
  Download,
  Eye,
  EyeOff,
  IdCard,
  PiggyBank,
  Play,
  Plus,
  Split,
  Users,
  Wallet as WalletIcon,
} from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { AccountDetails, PageBody } from '../layouts/app.tsx';
import { api, get, refreshMoney } from '../lib/api.ts';
import { ago, calendarDate, greeting, monthName, naira } from '../lib/format.ts';
import { refreshSession, useUser } from '../lib/session.ts';
import type { Dashboard, Notification, Page } from '../lib/types.ts';
import { FlowChart, PartitionRing } from '../ui/charts.tsx';
import {
  Async,
  Badge,
  Button,
  buttonClass,
  cx,
  EmptyState,
  IconButton,
  Modal,
  Notice,
  Panel,
  Segmented,
  Status,
  Tile,
} from '../ui/core.tsx';
import {
  ACCENTS,
  BeneficiaryForm,
  CreateFlow,
  IncomeForm,
  RuleForm,
  WalletForm,
  WalletGlyph,
  type RuleTarget,
} from '../ui/forms.tsx';
import { RunNow } from '../ui/run-now.tsx';
import { TransactionDrawer, TransactionTable } from '../ui/tables.tsx';
import { StatementModal } from './transactions.tsx';

function Hero({ onExport, onCreate }: { onExport: () => void; onCreate: () => void }) {
  const user = useUser();
  const notices = useQuery({
    queryKey: ['notifications', 'hero'],
    queryFn: () => get<Page<Notification>>('/v1/notifications?pageSize=3'),
  });
  const [index, setIndex] = useState(0);
  const items = notices.data?.items ?? [];
  const notice = items[Math.min(index, items.length - 1)];
  const today = new Date().toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  return (
    <section className="hero text-white">
      <div className="mx-auto flex max-w-[1400px] flex-col gap-6 px-4 pt-10 pb-5 sm:px-6 lg:flex-row lg:items-end lg:justify-between">
        <div className="order-2 lg:order-none">
          <h1 className="text-[28px] font-normal tracking-tight sm:text-[32px]">
            {greeting()}, {user.firstName}!
          </h1>
          <p className="text-[13px] text-white/75">{today}</p>
        </div>
        <div className="order-1 w-full max-w-sm rounded-xl border border-white/15 bg-white/6 p-4 lg:order-none">
          <div className="flex items-center justify-between text-[13px]">
            <span className="flex items-center gap-2">
              <Bell className="size-3.5" aria-hidden /> Notification
            </span>
            <Link to="/notifications" className="flex items-center gap-1 text-white/80 hover:text-white">
              View <ChevronRight className="size-3.5" aria-hidden />
            </Link>
          </div>
          <p className="mt-3 min-h-11 text-[14px]">
            {notice ? `${notice.title}. ${notice.body}` : 'You are all caught up.'}
          </p>
          {items.length > 1 && (
            <div className="mt-3 flex justify-center gap-1.5">
              {items.map((n, i) => (
                <button
                  key={n.id}
                  type="button"
                  aria-label={`Show notification ${i + 1} of ${items.length}`}
                  aria-pressed={i === index}
                  onClick={() => setIndex(i)}
                  className="flex size-6 items-center justify-center"
                >
                  <span
                    className={cx('h-1 rounded-full', i === index ? 'w-5 bg-brand' : 'w-2.5 bg-white/40')}
                  />
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="order-3 flex gap-3 lg:order-none">
          <Button variant="dark" onClick={onExport} icon={<Download className="size-4" aria-hidden />}>
            Export
          </Button>
          <Button onClick={onCreate} icon={<Plus className="size-4" aria-hidden />}>
            Create Wallet
          </Button>
        </div>
      </div>
    </section>
  );
}

function SetupDrawer({
  open,
  onClose,
  data,
  onChecklist,
}: {
  open: boolean;
  onClose: () => void;
  data: Dashboard;
  onChecklist: () => void;
}) {
  const { setup } = data;
  const checklist = setup.income && setup.destination && setup.rule;
  const steps = [
    { title: 'Signup Account', text: 'Create your PaySplit account', done: true, action: null },
    {
      title: 'Complete KYC',
      text: 'Verify using a government issued ID',
      done: setup.kyc,
      action: (
        <Link to="/onboarding" className={buttonClass('primary', 'sm')}>
          {setup.profile ? 'Continue' : 'Start'}
        </Link>
      ),
    },
    {
      title: 'Setup Checklist',
      text: 'Add your salary source and set your first rule',
      done: checklist,
      action: (
        <Button size="sm" onClick={onChecklist}>
          {setup.income || setup.destination ? 'Continue' : 'Start'}
        </Button>
      ),
    },
  ];
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Complete your account setup"
      side="right"
      width="max-w-sm"
      crown={false}
    >
      <div className="flex items-center justify-between gap-4 pb-2">
        <p className="text-[13px] text-muted">
          Verify your account to upgrade to Tier 2, unlock splitting and get a dedicated account number.
        </p>
        <svg
          viewBox="0 0 60 60"
          className="size-20 shrink-0"
          role="img"
          aria-label={`${setup.percent}% complete`}
        >
          <circle cx="30" cy="30" r="24" fill="none" stroke="#e6f2fe" strokeWidth="9" />
          <circle
            cx="30"
            cy="30"
            r="24"
            fill="none"
            stroke="#57a4ef"
            strokeWidth="9"
            strokeDasharray={`${(setup.percent / 100) * 150.8} 150.8`}
            transform="rotate(-90 30 30)"
          />
          <text x="30" y="34" textAnchor="middle" fontSize="12" fontWeight="600" fill="#111418">
            {setup.percent}%
          </text>
        </svg>
      </div>
      <ul className="space-y-2">
        {steps.map((s) => (
          <li key={s.title} className="flex items-center justify-between gap-3 rounded-xl border p-3">
            <div>
              <p className="font-semibold">{s.title}</p>
              <p className="text-[12px] text-muted">{s.text}</p>
            </div>
            {s.done ? (
              <Badge tone="good" icon={<Check className="size-3" aria-hidden />}>
                Done
              </Badge>
            ) : (
              s.action
            )}
          </li>
        ))}
      </ul>
    </Modal>
  );
}

const WIZARD = [
  { key: 'income', label: 'Income', hint: 'Salary info', icon: BriefcaseBusiness },
  { key: 'wallet', label: 'Wallets', hint: 'Savings pocket', icon: PiggyBank },
  { key: 'beneficiary', label: 'Recipients', hint: 'Beneficiary', icon: Users },
  { key: 'rule', label: 'Rules', hint: 'Split strategy', icon: Split },
] as const;

function SetupWizard({ open, onClose, start }: { open: boolean; onClose: () => void; start: number }) {
  const [step, setStep] = useState(start);
  const [target, setTarget] = useState<RuleTarget | undefined>();
  const skip = useMutation({
    mutationFn: () => api('POST', '/v1/me/setup/skip'),
    onSettled: () => void refreshMoney(),
  });
  const close = () => {
    skip.mutate();
    onClose();
  };
  const next = () => setStep((s) => s + 1);
  const back = (
    <Button variant="outline" onClick={() => setStep((s) => Math.max(0, s - 1))}>
      Go Back
    </Button>
  );
  if (!open) return null;
  const current = WIZARD[Math.min(step, WIZARD.length - 1)]!;
  return (
    <Modal
      open
      onClose={close}
      title="Configure your Salary Partitions"
      subtitle="Complete 4 steps to set up automated payroll distribution"
      width="max-w-xl"
    >
      <ol className="mx-auto mb-6 flex max-w-md justify-between">
        {WIZARD.map(({ key, label, hint, icon: Icon }, i) => (
          <li
            key={key}
            aria-current={i === step ? 'step' : undefined}
            className="relative flex flex-1 flex-col items-center text-center"
          >
            {i > 0 && (
              <span
                aria-hidden
                className={cx(
                  'absolute top-5 right-1/2 left-[-50%] mx-6 h-px',
                  i <= step ? 'bg-brand' : 'bg-line-strong',
                )}
              />
            )}
            <span
              aria-hidden
              className={cx(
                'relative flex size-10 items-center justify-center rounded-lg border',
                i <= step ? 'border-brand bg-brand-soft text-brand-ink' : 'bg-white text-muted',
              )}
            >
              <Icon className="size-4" />
            </span>
            <span className="mt-1.5 text-[12px] font-semibold">{label}</span>
            <span className="text-[11px] text-muted">{hint}</span>
          </li>
        ))}
      </ol>
      {current.key === 'income' && (
        <>
          <h3 className="mb-3 font-semibold">Salary Income Source</h3>
          <IncomeForm
            onDone={next}
            submitLabel="Next"
            secondary={
              <Button variant="outline" onClick={next}>
                Skip
              </Button>
            }
          />
        </>
      )}
      {current.key === 'wallet' && (
        <>
          <h3 className="mb-3 font-semibold">Create First Wallet</h3>
          <WalletForm
            single="Next"
            secondary={back}
            onSaved={(w) => {
              setTarget({ type: 'wallet', id: w.id });
              next();
            }}
          />
          <Button variant="ghost" size="sm" className="mt-2 w-full" onClick={next}>
            Skip this step
          </Button>
        </>
      )}
      {current.key === 'beneficiary' && (
        <>
          <h3 className="mb-3 font-semibold">Create First Recipient/Beneficiary</h3>
          <BeneficiaryForm
            single="Create Split Rule"
            secondary={back}
            onSaved={(b) => {
              setTarget((t) => t ?? { type: 'beneficiary', id: b.id });
              next();
            }}
          />
          <Button variant="ghost" size="sm" className="mt-2 w-full" onClick={next}>
            Skip this step
          </Button>
        </>
      )}
      {current.key === 'rule' && (
        <>
          <h3 className="mb-3 font-semibold">Create First Split Rule</h3>
          <RuleForm target={target} doneLabel="Complete Setup & Launch Dashboard" onDone={close} />
        </>
      )}
    </Modal>
  );
}

export function DashboardPage() {
  const user = useUser();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const query = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => get<Dashboard>('/v1/dashboard'),
    refetchInterval: 15_000,
  });
  const [hidden, setHidden] = useState(() => localStorage.getItem('ps-hide-balance') === '1');
  const [panel, setPanel] = useState<'export' | 'wallet' | 'account' | 'setup' | 'run' | null>(null);
  const [wizard, setWizard] = useState(params.get('setup') === '1');
  const [group, setGroup] = useState<'all' | 'wallet' | 'beneficiary'>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  const retry = useMutation({
    mutationFn: () => api('POST', '/v1/salary-account/provision'),
    onSettled: async () => {
      await Promise.all([refreshMoney(), refreshSession()]);
    },
  });
  const close = () => setPanel(null);
  const show = (kobo: number) => (hidden ? '₦ ••••••' : naira(kobo));

  return (
    <>
      <Hero onExport={() => setPanel('export')} onCreate={() => setPanel('wallet')} />
      <PageBody>
        <Async query={query} rows={8}>
          {(d) => {
            const account = d.account;
            const setupDone = d.setup.kyc && d.setup.income && d.setup.destination && d.setup.rule;
            const transactions = d.recentTransactions.filter(
              (t) => group === 'all' || (group === 'wallet' ? t.walletId : t.beneficiaryId),
            );
            return (
              <div className="space-y-5">
                {!setupDone && (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-card border bg-brand-wash px-5 py-4">
                    <span className="flex items-center gap-3">
                      <span
                        className="flex size-10 items-center justify-center rounded-lg bg-brand-soft text-brand-ink"
                        aria-hidden
                      >
                        <IdCard className="size-5" />
                      </span>
                      <span>
                        <span className="block font-semibold">Complete onboarding</span>
                        <span className="block text-[13px] text-muted">
                          {d.setup.kyc
                            ? 'Finish your salary, destination and rule setup so your next salary splits itself.'
                            : 'Verify your account to unlock splitting and get a dedicated account number.'}
                        </span>
                      </span>
                    </span>
                    <Button onClick={() => setPanel('setup')}>
                      Complete Onboarding <ArrowRight className="size-4" aria-hidden />
                    </Button>
                  </div>
                )}
                {account?.status === 'failed' && (
                  <Notice
                    tone="bad"
                    title="We could not set up your salary account"
                    action={
                      <Button
                        size="sm"
                        variant="outline"
                        busy={retry.isPending}
                        onClick={() => retry.mutate()}
                      >
                        Try again
                      </Button>
                    }
                  >
                    {account.failureReason ?? 'The provider refused the request.'}
                  </Notice>
                )}
                {account?.status === 'provisioning' && (
                  <Notice title="Your salary account is being set up">
                    This usually takes under a minute. You will get a notification when it is ready.
                  </Notice>
                )}
                {d.expected?.awaited && (
                  <Notice tone="warn" title="Salary not received yet">
                    Your expected date has passed. Your split will run as soon as the salary is confirmed.
                  </Notice>
                )}

                <section
                  aria-label="Summary"
                  className="grid gap-4 md:grid-cols-2 xl:grid-cols-[1.2fr_1fr_1fr_1fr]"
                >
                  <div className="flex flex-col justify-end py-2">
                    <p className="text-[13px] text-[#3a4450]">Salary Account Balance</p>
                    <p className="num flex items-center gap-2 text-[34px] leading-tight font-bold tracking-tight">
                      {show(account?.balance ?? 0)}
                      <IconButton
                        label={hidden ? 'Show balances' : 'Hide balances'}
                        onClick={() => {
                          setHidden(!hidden);
                          localStorage.setItem('ps-hide-balance', hidden ? '0' : '1');
                        }}
                      >
                        {hidden ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                      </IconButton>
                    </p>
                    <p className="mt-1 flex flex-wrap items-center gap-2 text-[13px] text-muted">
                      {account?.accountNumber
                        ? `••••${account.accountNumber.slice(-4)} ${user.firstName} ${user.lastName}`
                        : 'No account number yet'}
                      <button
                        type="button"
                        onClick={() => (account ? setPanel('account') : navigate('/onboarding'))}
                        className="min-h-6 font-medium text-brand-ink hover:underline"
                      >
                        {account ? 'View Account Details' : 'Get an account number'}
                      </button>
                    </p>
                  </div>
                  <Tile
                    label={`Split Allocation, ${monthName(d.period.month)}`}
                    value={show(d.period.allocated)}
                    note={`${d.activeRules} active ${d.activeRules === 1 ? 'rule' : 'rules'}`}
                    aside={
                      d.period.salaryReceived > 0 ? (
                        <span>
                          {Math.round((d.period.allocated / d.period.salaryReceived) * 100)}% of salary
                        </span>
                      ) : (
                        <span>No salary yet</span>
                      )
                    }
                    to="/rules"
                  />
                  <Tile
                    label="Total in Wallets"
                    value={show(d.walletTotal)}
                    note={`${d.wallets.length} active ${d.wallets.length === 1 ? 'wallet' : 'wallets'}`}
                    aside={
                      <span>{d.targetWallets ? `${d.targetWallets} with a target` : 'No targets set'}</span>
                    }
                    to="/destinations"
                  />
                  <Tile
                    label="Expected Next Split"
                    value={d.expected ? calendarDate(d.expected.date) : 'Not set'}
                    note="Expected, not confirmed"
                    aside={
                      d.runNowAvailable ? (
                        <Badge tone="good">Funds available</Badge>
                      ) : (
                        <Badge>{d.expected ? 'Awaiting salary' : 'Set a date'}</Badge>
                      )
                    }
                    to="/settings"
                  />
                </section>

                {d.runNowAvailable && (
                  <Notice
                    title="You have unallocated salary"
                    action={
                      <Button
                        size="sm"
                        icon={<Play className="size-3.5" aria-hidden />}
                        onClick={() => setPanel('run')}
                      >
                        Run Now
                      </Button>
                    }
                  >
                    Some of your active rules have not been funded from your salary yet.
                  </Notice>
                )}

                <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
                  <Panel title="Salary Allocation & Split Cash Flow">
                    <p className="num text-[22px] font-semibold tracking-tight">
                      {show(d.period.salaryReceived)}
                    </p>
                    <p className="text-[13px] text-muted">
                      Salary received in {monthName(d.period.month)}. Bars show what was allocated each month.
                    </p>
                    <div className="mt-2">
                      <FlowChart months={d.months} />
                    </div>
                  </Panel>
                  <Panel
                    title="Salary Partition"
                    actions={
                      <Link
                        to="/rules"
                        className="flex min-h-6 items-center gap-1 text-[13px] text-brand-ink hover:underline"
                      >
                        See rules <ChevronRight className="size-3.5" aria-hidden />
                      </Link>
                    }
                  >
                    <PartitionRing
                      salary={d.partition?.salary ?? 0}
                      wallets={d.partition?.wallets ?? 0}
                      beneficiaries={d.partition?.beneficiaries ?? 0}
                      pending={d.partition?.pending ?? 0}
                      remaining={d.partition?.remaining ?? 0}
                    />
                    <dl className="mt-5 grid grid-cols-2 gap-3">
                      {[
                        ['Wallets', d.partition?.wallets ?? 0, '#57a4ef'],
                        ['Beneficiaries', d.partition?.beneficiaries ?? 0, '#111418'],
                      ].map(([label, value, color]) => (
                        <div
                          key={label as string}
                          className="border-l-[3px] pl-3"
                          style={{ borderColor: color as string }}
                        >
                          <dd className="num font-semibold">{show(value as number)}</dd>
                          <dt className="text-[12px] text-muted">{label}</dt>
                        </div>
                      ))}
                    </dl>
                    {Boolean(d.partition?.pending) && (
                      <p className="mt-3 text-[12px] text-muted">
                        {show(d.partition!.pending)} is on its way to beneficiaries and not counted yet.
                      </p>
                    )}
                  </Panel>
                </div>

                <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
                  <Panel
                    flush
                    title="Recent Activity & Splits"
                    actions={
                      <Segmented
                        label="Show"
                        value={group}
                        onChange={setGroup}
                        options={[
                          ['all', 'All Transactions'],
                          ['wallet', 'Wallets'],
                          ['beneficiary', 'Beneficiaries'],
                        ]}
                      />
                    }
                  >
                    {transactions.length === 0 ? (
                      <EmptyState title="No activity yet">
                        Activity is displayed here once your salary arrives.
                      </EmptyState>
                    ) : (
                      <TransactionTable items={transactions} showReference={false} onOpen={setOpenId} />
                    )}
                    <div className="flex justify-end border-t px-4 py-2.5">
                      <Link
                        to="/transactions"
                        className="flex min-h-6 items-center gap-1 text-[13px] text-brand-ink hover:underline"
                      >
                        View Full Ledger <ChevronRight className="size-3.5" aria-hidden />
                      </Link>
                    </div>
                  </Panel>
                  <div className="space-y-4">
                    <Panel
                      flush
                      title="Wallets"
                      actions={
                        <Link
                          to="/destinations"
                          aria-label="All wallets"
                          className="inline-flex size-8 items-center justify-center rounded-lg hover:bg-white"
                        >
                          <ChevronRight className="size-4" />
                        </Link>
                      }
                    >
                      {d.wallets.length === 0 ? (
                        <EmptyState
                          icon={<WalletIcon className="size-5" />}
                          title="No wallets created"
                          action={
                            <Button size="sm" onClick={() => setPanel('wallet')}>
                              Create Wallet
                            </Button>
                          }
                        >
                          Group your savings by purpose.
                        </EmptyState>
                      ) : (
                        <ul className="space-y-1 p-1">
                          {d.wallets.slice(0, 4).map((w) => (
                            <li key={w.id}>
                              <Link
                                to={`/destinations/wallets/${w.id}`}
                                className="flex items-center gap-3 rounded-lg px-3 py-2.5 hover:brightness-98"
                                style={{ background: ACCENTS[w.accent]?.card }}
                              >
                                <WalletGlyph wallet={w} />
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate text-[13px] font-semibold">{w.name}</span>
                                  <span className="block text-[12px] text-[#4b5563] capitalize">
                                    {w.category}
                                  </span>
                                </span>
                                <span className="num text-[15px]">{show(w.balance)}</span>
                              </Link>
                            </li>
                          ))}
                        </ul>
                      )}
                    </Panel>
                    <Panel
                      flush
                      title="Recent splits"
                      actions={
                        <Link to="/rules?tab=history" className="text-[13px] text-brand-ink hover:underline">
                          History
                        </Link>
                      }
                    >
                      {d.recentSplits.length === 0 ? (
                        <EmptyState title="No splits yet">
                          Your first split runs when your salary is confirmed.
                        </EmptyState>
                      ) : (
                        <ul className="divide-y">
                          {d.recentSplits.slice(0, 3).map((s) => (
                            <li key={s.id}>
                              <Link
                                to={`/splits/${s.id}`}
                                className="flex items-center justify-between gap-3 px-4 py-3 text-[13px] hover:bg-brand-wash"
                              >
                                <span>
                                  <span className="block font-medium">
                                    {show(s.toWallets + s.toBeneficiaries)} allocated
                                  </span>
                                  <span className="block text-[12px] text-muted">
                                    {ago(s.createdAt)}, {s.trigger === 'manual' ? 'Run Now' : 'automatic'}
                                  </span>
                                </span>
                                <Status value={s.status} />
                              </Link>
                            </li>
                          ))}
                        </ul>
                      )}
                    </Panel>
                  </div>
                </div>
                <SetupDrawer
                  open={panel === 'setup'}
                  onClose={close}
                  data={d}
                  onChecklist={() => {
                    close();
                    setWizard(true);
                  }}
                />
                <SetupWizard
                  open={wizard}
                  start={!d.setup.income ? 0 : !d.setup.destination ? 1 : 3}
                  onClose={() => {
                    setWizard(false);
                    if (params.has('setup')) setParams({}, { replace: true });
                  }}
                />
                {account && (
                  <Modal
                    open={panel === 'account'}
                    onClose={close}
                    title="Salary account"
                    subtitle="Share these details with your employer or payroll team"
                    width="max-w-sm"
                  >
                    <AccountDetails account={account} />
                    <p className="mt-4 text-[12px] text-muted">
                      Every transfer into this account is treated as salary. Test environment: no real money
                      moves.
                    </p>
                  </Modal>
                )}
              </div>
            );
          }}
        </Async>
      </PageBody>
      <StatementModal open={panel === 'export'} onClose={close} />
      <CreateFlow kind={panel === 'wallet' ? 'wallet' : null} onClose={close} />
      <RunNow open={panel === 'run'} onClose={close} />
      <TransactionDrawer id={openId} onClose={() => setOpenId(null)} />
    </>
  );
}
