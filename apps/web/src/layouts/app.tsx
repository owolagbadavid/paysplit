import { useMutation, useQuery } from '@tanstack/react-query';
import { Bell, Search } from 'lucide-react';
import { useState } from 'react';
import { Link, Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { api, get, queryClient } from '../lib/api.ts';
import { useSession } from '../lib/session.ts';
import type { Dashboard, Notification, Page, SalaryAccount } from '../lib/types.ts';
import {
  Avatar,
  Button,
  buttonClass,
  Confirm,
  CopyButton,
  cx,
  ErrorState,
  Loading,
  Modal,
  Notice,
  Status,
  Wordmark,
} from '../ui/core.tsx';

const NAV = [
  ['/dashboard', 'Dashboard'],
  ['/transactions', 'Transactions'],
  ['/destinations', 'Destination'],
  ['/rules', 'Split Rules'],
] as const;

export function TopNav({
  items,
  home,
  right,
  label,
}: {
  items: readonly (readonly [string, string])[];
  home: string;
  right: React.ReactNode;
  label: string;
}) {
  return (
    <header className="sticky top-0 z-30 border-b bg-white">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center justify-between gap-x-4 px-4 sm:px-6">
        <Wordmark to={home} className="h-14" />
        <nav
          aria-label={label}
          className="order-3 -mx-4 flex w-[calc(100%+32px)] overflow-x-auto px-2 sm:mx-0 sm:w-auto sm:px-0 lg:order-none"
        >
          {items.map(([to, text]) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/admin'}
              className={({ isActive }) =>
                cx(
                  'flex h-12 items-center border-b-2 px-2.5 text-[13px] whitespace-nowrap sm:px-3 sm:text-[14px] lg:h-14',
                  isActive
                    ? 'border-brand font-semibold'
                    : 'border-transparent text-[#3a4450] hover:text-ink',
                )
              }
            >
              {text}
            </NavLink>
          ))}
        </nav>
        <div className="flex items-center gap-1.5">{right}</div>
      </div>
    </header>
  );
}

export function AccountDetails({ account }: { account: SalaryAccount }) {
  if (account.status === 'failed') {
    return (
      <Notice tone="bad" title="We could not set up your salary account">
        {account.failureReason ?? 'Try again from your dashboard.'}
      </Notice>
    );
  }
  if (account.status !== 'active') {
    return (
      <Notice title="Your salary account is being set up">
        This usually takes under a minute. We will notify you when it is ready.
      </Notice>
    );
  }
  return (
    <dl className="space-y-3 text-[13px]">
      <div>
        <dt className="text-muted">Account Number</dt>
        <dd className="num flex items-center justify-between text-[22px] font-semibold tracking-wide">
          {account.accountNumber}
          <CopyButton
            label="Copy account details"
            value={`${account.accountNumber}\n${account.accountName}\n${account.bankName}`}
          />
        </dd>
      </div>
      <div>
        <dt className="text-muted">Account Name</dt>
        <dd className="font-semibold">{account.accountName}</dd>
      </div>
      <div>
        <dt className="text-muted">Bank Name</dt>
        <dd className="font-semibold">{account.bankName}</dd>
      </div>
    </dl>
  );
}

function ProfileMenu({
  open,
  onClose,
  onSignOut,
}: {
  open: boolean;
  onClose: () => void;
  onSignOut: () => void;
}) {
  const user = useSession().data!.user!;
  const account = useQuery({
    queryKey: ['dashboard', 'account'],
    queryFn: () => get<{ account: SalaryAccount | null }>('/v1/salary-account'),
    enabled: open,
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Your account"
      side="right"
      width="max-w-sm"
      crown={false}
      hideTitle
    >
      <div className="flex items-center gap-3 pb-4">
        <Avatar name={`${user.firstName} ${user.lastName}`} className="size-11 text-sm" />
        <div>
          <p className="font-semibold">
            {user.firstName} {user.lastName}
          </p>
          <p className="text-[13px] text-muted">Tier {user.tier}</p>
        </div>
      </div>
      <div className="border-t pt-4">
        {account.data ? (
          account.data.account ? (
            <AccountDetails account={account.data.account} />
          ) : (
            <Notice
              action={
                <Link to="/onboarding" onClick={onClose} className="font-semibold underline">
                  Verify now
                </Link>
              }
            >
              Verify your identity to get a salary account.
            </Notice>
          )
        ) : account.error ? (
          <ErrorState error={account.error} />
        ) : (
          <Loading rows={2} />
        )}
      </div>
      <div className="mt-5 grid grid-cols-2 gap-3">
        <Button variant="outline" onClick={onSignOut}>
          Log Out
        </Button>
        <Link to="/settings" onClick={onClose} className={buttonClass()}>
          View Profile
        </Link>
      </div>
    </Modal>
  );
}

export function AppLayout() {
  const { data, isPending, error, refetch } = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const [menu, setMenu] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const user = data?.user;
  const notices = useQuery({
    queryKey: ['notifications', 'badge'],
    queryFn: () => get<Page<Notification> & { unread: number }>('/v1/notifications?pageSize=1'),
    enabled: Boolean(user),
    refetchInterval: 20_000,
  });
  const signOut = useMutation({
    mutationFn: () => api('POST', '/v1/auth/logout'),
    onSettled: async () => {
      queryClient.clear();
      await navigate('/');
    },
  });

  if (isPending) return <Loading label="Opening PaySplit" rows={8} />;
  if (error) return <ErrorState error={error} retry={() => void refetch()} />;
  if (!user)
    return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  const unread = notices.data?.unread ?? 0;

  return (
    <div className="min-h-dvh">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-2 focus:rounded-lg focus:bg-white focus:p-3"
      >
        Skip to content
      </a>
      <TopNav
        items={NAV}
        home="/dashboard"
        label="Main"
        right={
          <>
            <Link
              to="/transactions?focus=search"
              aria-label="Search transactions"
              className="inline-flex size-10 items-center justify-center rounded-full border hover:bg-strip"
            >
              <Search className="size-4" aria-hidden />
            </Link>
            <Link
              to="/notifications"
              aria-label={`Notifications, ${unread} unread`}
              className="relative inline-flex size-10 items-center justify-center rounded-full border hover:bg-strip"
            >
              <Bell className="size-4" aria-hidden />
              {unread > 0 && (
                <span
                  aria-hidden
                  className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-bad px-1 text-[10px] font-semibold text-white"
                >
                  {unread > 9 ? '9+' : unread}
                </span>
              )}
            </Link>
            <button
              type="button"
              onClick={() => setMenu(true)}
              aria-haspopup="dialog"
              className="flex h-10 items-center gap-2 rounded-full border py-1 pr-3 pl-1.5 hover:bg-strip"
            >
              <Avatar name={`${user.firstName} ${user.lastName}`} />
              <span className="max-w-24 truncate text-[13px]">{user.firstName}</span>
            </button>
          </>
        }
      />
      <main id="main" tabIndex={-1} className="outline-none">
        <Outlet />
      </main>
      <ProfileMenu
        open={menu}
        onClose={() => setMenu(false)}
        onSignOut={() => {
          setMenu(false);
          setLeaving(true);
        }}
      />
      <Confirm
        open={leaving}
        onClose={() => setLeaving(false)}
        onConfirm={() => signOut.mutate()}
        busy={signOut.isPending}
        title="Sign out of Paysplit?"
        confirmLabel="Sign out"
      >
        If you sign out you’ll need to sign in again to access your account.
      </Confirm>
    </div>
  );
}

export function PageBody({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6">{children}</div>;
}

/** Explains what is locked and what unlocks it. The API enforces the same rule. */
export function VerificationNotice({ dashboard }: { dashboard?: Dashboard }) {
  const user = useSession().data!.user!;
  if (user.kycStatus === 'approved' || dashboard?.setup.kyc) return null;
  return (
    <Notice
      tone="warn"
      title="Verification needed"
      action={
        <Link to="/onboarding" className={buttonClass('outline', 'sm')}>
          Continue
        </Link>
      }
    >
      You can set up wallets, beneficiaries and draft rules now. Activating rules and moving money unlock once
      you are verified. <Status value={user.kycStatus} />
    </Notice>
  );
}
