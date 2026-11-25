import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, Navigate, Outlet, useLocation, useNavigate } from 'react-router';
import { api, queryClient } from '../lib/api.ts';
import { useAdminSession } from '../lib/session.ts';
import { Avatar, Button, Confirm, ErrorState, Loading } from '../ui/core.tsx';
import { TopNav } from './app.tsx';

const NAV = [
  ['/admin', 'Overview'],
  ['/admin/users', 'Manage Users'],
  ['/admin/salary', 'Salary'],
  ['/admin/pay-ins', 'Test runs'],
  ['/admin/operations', 'Operations'],
  ['/admin/settings', 'Settings'],
] as const;

/** Administration is its own area with its own session. A customer session opens nothing here. */
export function AdminLayout() {
  const { data, isPending, error, refetch } = useAdminSession();
  const location = useLocation();
  const navigate = useNavigate();
  const [leaving, setLeaving] = useState(false);
  const signOut = useMutation({
    mutationFn: () => api('POST', '/v1/admin/auth/logout'),
    onSettled: async () => {
      queryClient.clear();
      await navigate('/admin/login');
    },
  });
  if (isPending) return <Loading label="Opening administration" rows={8} />;
  if (error) return <ErrorState error={error} retry={() => void refetch()} />;
  if (!data?.admin)
    return <Navigate to={`/admin/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  const admin = data.admin;
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
        home="/admin"
        label="Administration"
        right={
          <>
            <Link
              to="/admin/settings"
              className="flex h-10 items-center gap-2 rounded-full border py-1 pr-3 pl-1.5 text-[13px] hover:bg-strip"
            >
              <Avatar name={`${admin.firstName} ${admin.lastName}`} /> {admin.firstName}
            </Link>
            <Button variant="outline" size="sm" onClick={() => setLeaving(true)}>
              Sign out
            </Button>
          </>
        }
      />
      <main id="main" tabIndex={-1} className="mx-auto max-w-[1400px] px-4 py-6 outline-none sm:px-6">
        <Outlet />
      </main>
      <Confirm
        open={leaving}
        onClose={() => setLeaving(false)}
        onConfirm={() => signOut.mutate()}
        busy={signOut.isPending}
        title="Sign out of administration?"
        confirmLabel="Sign out"
      >
        You’ll need your administrator password to come back.
      </Confirm>
    </div>
  );
}
