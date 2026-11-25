import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { ChevronRight, Download, Laptop } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { changePasswordSchema, country as countryOf } from '@paysplit/core';
import { AccountDetails, PageBody } from '../layouts/app.tsx';
import { api, download, get, query as qs, queryClient } from '../lib/api.ts';
import { ago, date, dateTime, naira, title } from '../lib/format.ts';
import { setUser, useUser } from '../lib/session.ts';
import type { Page, Prefs, SalaryAccount, Session, User, Wallet } from '../lib/types.ts';
import {
  Async,
  Avatar,
  Button,
  buttonClass,
  CopyButton,
  cx,
  EmptyState,
  fieldErrors,
  FormError,
  Input,
  Modal,
  Notice,
  PageHeader,
  Pagination,
  Panel,
  PasswordInput,
  Status,
  Toggle,
  useToast,
} from '../ui/core.tsx';
import { ACCENTS, IncomeForm, WalletGlyph } from '../ui/forms.tsx';
import { zodErrors } from './auth.tsx';

export function ChangePasswordForm({
  path,
  changedAt,
  onDone,
}: {
  path: string;
  changedAt: string;
  onDone?: () => void;
}) {
  const toast = useToast();
  const empty = { currentPassword: '', newPassword: '', confirm: '' };
  const [form, setForm] = useState(empty);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: () =>
      api('POST', path, { currentPassword: form.currentPassword, newPassword: form.newPassword }),
    onSuccess: () => {
      setForm(empty);
      toast('Password changed. Your other devices were signed out.');
      onDone?.();
    },
  });
  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const found = zodErrors(changePasswordSchema.safeParse(form));
        if (form.newPassword !== form.confirm) found.confirm = 'Passwords do not match';
        setErrors(found);
        if (Object.keys(found).length === 0) save.mutate();
      }}
    >
      <p className="text-[13px] text-muted">Last updated {date(changedAt)}</p>
      <PasswordInput
        label="Current Password"
        autoComplete="current-password"
        value={form.currentPassword}
        onChange={(e) => setForm({ ...form, currentPassword: e.target.value })}
        error={errors.currentPassword}
      />
      <div className="grid items-start gap-4 sm:grid-cols-2">
        <PasswordInput
          label="New Password"
          autoComplete="new-password"
          value={form.newPassword}
          onChange={(e) => setForm({ ...form, newPassword: e.target.value })}
          error={errors.newPassword}
          showRules
        />
        <PasswordInput
          label="Confirm New Password"
          autoComplete="new-password"
          value={form.confirm}
          onChange={(e) => setForm({ ...form, confirm: e.target.value })}
          error={errors.confirm}
        />
      </div>
      <FormError error={save.error} />
      <Button type="submit" variant="brandOutline" busy={save.isPending}>
        Change password
      </Button>
    </form>
  );
}

function PersonalDetails() {
  const user = useUser();
  const toast = useToast();
  const verified = user.kycStatus === 'approved';
  const [form, setForm] = useState({
    firstName: user.firstName,
    lastName: user.lastName,
    phone: user.phone ?? '',
  });
  const save = useMutation({
    mutationFn: () =>
      api<User>('PATCH', '/v1/me', {
        firstName: form.firstName,
        lastName: form.lastName,
        ...(form.phone ? { phone: form.phone } : {}),
      }),
    onSuccess: (next) => {
      setUser(next);
      toast('Profile saved');
    },
  });
  const errors = fieldErrors(save.error);
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          label="First name"
          value={form.firstName}
          disabled={verified}
          onChange={(e) => setForm({ ...form, firstName: e.target.value })}
          error={errors.firstName}
          required
        />
        <Input
          label="Last name"
          value={form.lastName}
          disabled={verified}
          onChange={(e) => setForm({ ...form, lastName: e.target.value })}
          error={errors.lastName}
          required
        />
        <Input label="Email address" value={user.email} disabled />
        <Input
          label="Phone Number"
          type="tel"
          value={form.phone}
          disabled={!user.country}
          onChange={(e) => setForm({ ...form, phone: e.target.value })}
          error={errors.phone}
          hint={user.country ? countryOf(user.country)?.name : 'Add your country during verification first'}
        />
      </div>
      {verified && (
        <p className="text-[13px] text-muted">Your name was verified, so it cannot be changed here.</p>
      )}
      <FormError error={save.error} />
      <Button type="submit" busy={save.isPending}>
        Save changes
      </Button>
    </form>
  );
}

const PREFS: [keyof Prefs, string, string][] = [
  ['salary_received', 'Salary received', 'When a salary is confirmed in your account'],
  ['split_executed', 'Split results', 'When a split completes, in full or in part'],
  ['disbursement_receipt', 'Transfer receipts', 'A receipt for each completed transfer'],
  ['upcoming_split', 'Upcoming splits', 'The day before your expected salary date'],
  ['monthly_summary', 'Monthly summary', 'What last month’s salary became'],
];

function Notifications() {
  const user = useUser();
  const toast = useToast();
  const save = useMutation({
    mutationFn: (prefs: Prefs) => api<Prefs>('PUT', '/v1/me/notification-preferences', prefs),
    onMutate: (prefs) => setUser({ ...user, notificationPrefs: prefs }),
    onError: () => {
      setUser(user);
      toast('That did not save. Try again.', 'bad');
    },
  });
  return (
    <>
      <p className="mb-1 text-[13px] text-muted">Optional emails. In-app notifications are always on.</p>
      <div className="divide-y">
        {PREFS.map(([key, label, description]) => (
          <Toggle
            key={key}
            label={label}
            description={description}
            checked={user.notificationPrefs[key]}
            onChange={(v) => save.mutate({ ...user.notificationPrefs, [key]: v })}
          />
        ))}
        <Toggle
          label="Security, verification and failed transfers"
          description="Always sent, because you need to know"
          checked
          disabled
          onChange={() => {}}
        />
      </div>
    </>
  );
}

function browserName(agent: string | null): string {
  if (!agent) return 'Unknown device';
  const browser = /Edg\//.test(agent)
    ? 'Edge'
    : /Chrome\//.test(agent)
      ? 'Chrome'
      : /Firefox\//.test(agent)
        ? 'Firefox'
        : /Safari\//.test(agent)
          ? 'Safari'
          : 'Browser';
  const system = /iPhone|iPad/.test(agent)
    ? 'iOS'
    : /Android/.test(agent)
      ? 'Android'
      : /Mac OS/.test(agent)
        ? 'macOS'
        : /Windows/.test(agent)
          ? 'Windows'
          : /Linux/.test(agent)
            ? 'Linux'
            : '';
  return system ? `${browser} on ${system}` : browser;
}

function Devices() {
  const query = useQuery({ queryKey: ['sessions'], queryFn: () => get<Session[]>('/v1/me/sessions') });
  const revoke = useMutation({
    mutationFn: (id: string) => api('DELETE', `/v1/me/sessions/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sessions'] }),
  });
  return (
    <Async query={query} rows={2}>
      {(items) => (
        <ul className="divide-y">
          {items.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-3 py-3 text-[13px]">
              <span className="flex items-center gap-3">
                <Laptop className="size-4 text-muted" aria-hidden />
                <span>
                  <span className="block font-medium">
                    {browserName(s.userAgent)} {s.current && <span className="text-good">(this device)</span>}
                  </span>
                  <span className="block text-[12px] text-muted">
                    {s.ip ?? 'Unknown address'}, active {ago(s.lastSeenAt)}
                  </span>
                </span>
              </span>
              {!s.current && (
                <Button
                  variant="outline"
                  size="sm"
                  busy={revoke.isPending && revoke.variables === s.id}
                  onClick={() => revoke.mutate(s.id)}
                >
                  Sign out
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Async>
  );
}

function Activity() {
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: ['activity', page],
    queryFn: () =>
      get<Page<{ id: string; action: string; actorType: string; ip: string | null; createdAt: string }>>(
        `/v1/me/activity${qs({ page, pageSize: 8 })}`,
      ),
    placeholderData: keepPreviousData,
  });
  return (
    <Async query={query} rows={4}>
      {(data) =>
        data.total === 0 ? (
          <EmptyState title="No activity yet" />
        ) : (
          <>
            <ul className="divide-y">
              {data.items.map((a) => (
                <li key={a.id} className="flex justify-between gap-4 py-2.5 text-[13px]">
                  <span>
                    {title(a.action.replace('.', ': '))}
                    {a.actorType !== 'user' && (
                      <span className="text-muted">
                        {' '}
                        by {a.actorType === 'admin' ? 'a PaySplit administrator' : 'PaySplit'}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-muted">{dateTime(a.createdAt)}</span>
                </li>
              ))}
            </ul>
            <Pagination {...data} noun="events" onPage={setPage} />
          </>
        )
      }
    </Async>
  );
}

function CloseAccount({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const close = useMutation({
    mutationFn: () => api('POST', '/v1/me/close', { password }),
    onSuccess: async () => {
      queryClient.clear();
      await navigate('/');
    },
  });
  return (
    <Modal open={open} onClose={onClose} title="Close your account" width="max-w-md" crown={false}>
      <Notice tone="warn">
        Your rules are deleted and you are signed out everywhere. Your contact details are removed. Financial
        records are kept, as the law requires. This cannot be undone, and an account that still holds money
        cannot be closed.
      </Notice>
      <form
        className="mt-4 space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          close.mutate();
        }}
      >
        <PasswordInput
          label="Enter your password to confirm"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <FormError error={close.error} />
        <div className="grid grid-cols-2 gap-3">
          <Button variant="outline" onClick={onClose}>
            Keep my account
          </Button>
          <Button type="submit" variant="danger" busy={close.isPending} disabled={!password}>
            Close account
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function SettingsPage() {
  const user = useUser();
  const toast = useToast();
  const [closing, setClosing] = useState(false);
  const account = useQuery({
    queryKey: ['dashboard', 'account'],
    queryFn: () => get<{ account: SalaryAccount | null }>('/v1/salary-account'),
  });
  const wallets = useQuery({ queryKey: ['wallets'], queryFn: () => get<{ items: Wallet[] }>('/v1/wallets') });
  const save = useMutation({
    mutationFn: () => download('/v1/me/export'),
    onError: (e) => toast((e as Error).message, 'bad'),
  });
  return (
    <PageBody>
      <PageHeader
        title="Profile & Setting"
        crumbs={[{ label: 'Dashboard', to: '/dashboard' }, { label: 'Profile & Setting' }]}
      />
      <div className="grid items-start gap-4 lg:grid-cols-[320px_1fr]">
        <div className="space-y-4">
          <div className="tile rounded-card border p-5">
            <div className="flex items-center gap-3">
              <Avatar name={`${user.firstName} ${user.lastName}`} className="size-14 text-lg" />
              <div>
                <p className="text-[17px] font-semibold">
                  {user.firstName} {user.lastName}
                </p>
                <p className="text-[13px] text-muted">Tier {user.tier}</p>
              </div>
            </div>
            <dl className="mt-5 space-y-2 text-[13px]">
              <div className="flex items-center justify-between">
                <dt className="text-muted">Account ID</dt>
                <dd className="num flex items-center">
                  {user.id.slice(0, 8).toUpperCase()}
                  <CopyButton value={user.id} label="Copy account ID" />
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">Member since</dt>
                <dd>{date(user.createdAt)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">Verification</dt>
                <dd>
                  <Status value={user.kycStatus} />
                </dd>
              </div>
            </dl>
            {user.kycStatus !== 'approved' && (
              <Link to="/onboarding" className={cx(buttonClass('brandOutline'), 'mt-4 w-full')}>
                Continue verification
              </Link>
            )}
          </div>
          <Panel title="Account Details">
            <Async query={account} rows={2}>
              {({ account: a }) =>
                a ? (
                  <AccountDetails account={a} />
                ) : (
                  <p className="text-[13px] text-muted">
                    Verify your identity to get a dedicated salary account.
                  </p>
                )
              }
            </Async>
          </Panel>
          <Panel title="Wallets" flush>
            <Async query={wallets} rows={2}>
              {({ items }) =>
                items.length === 0 ? (
                  <EmptyState title="No wallets created" />
                ) : (
                  <ul className="space-y-1 p-1">
                    {items.slice(0, 4).map((w) => (
                      <li key={w.id}>
                        <Link
                          to={`/destinations/wallets/${w.id}`}
                          className="flex items-center gap-3 rounded-lg px-3 py-2.5"
                          style={{ background: ACCENTS[w.accent]?.card }}
                        >
                          <WalletGlyph wallet={w} />
                          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{w.name}</span>
                          <span className="num">{naira(w.balance)}</span>
                          <ChevronRight className="size-4" aria-hidden />
                        </Link>
                      </li>
                    ))}
                  </ul>
                )
              }
            </Async>
          </Panel>
        </div>
        <div className="space-y-4">
          <Panel title="Personal details">
            <PersonalDetails />
          </Panel>
          <Panel title="Salary Income Source">
            <IncomeForm submitLabel="Save income details" onDone={() => toast('Income details saved')} />
          </Panel>
          <Panel title="Notifications">
            <Notifications />
          </Panel>
          <Panel title="Security">
            <ChangePasswordForm
              path="/v1/me/change-password"
              changedAt={user.passwordChangedAt}
              onDone={() => void queryClient.invalidateQueries({ queryKey: ['session'] })}
            />
          </Panel>
          <Panel title="Signed-in devices">
            <Devices />
          </Panel>
          <Panel title="Account activity">
            <Activity />
          </Panel>
          <Panel title="Your data">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="max-w-md text-[13px] text-muted">
                Download everything PaySplit holds about you, or close your account.
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  icon={<Download className="size-4" aria-hidden />}
                  busy={save.isPending}
                  onClick={() => save.mutate()}
                >
                  Export my data
                </Button>
                <Button variant="outline" className="text-bad" onClick={() => setClosing(true)}>
                  Close account
                </Button>
              </div>
            </div>
          </Panel>
        </div>
      </div>
      <CloseAccount open={closing} onClose={() => setClosing(false)} />
    </PageBody>
  );
}
