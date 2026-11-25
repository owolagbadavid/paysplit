import { useMutation } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, Navigate, Outlet, useNavigate, useSearchParams } from 'react-router';
import { api, queryClient } from '../../lib/api.ts';
import { useAdminSession } from '../../lib/session.ts';
import type { Admin } from '../../lib/types.ts';
import { Button, FormError, Input, Notice, PasswordInput, Wordmark } from '../../ui/core.tsx';
import { ForgotPasswordForm, ResetPasswordForm } from '../auth.tsx';

export function AdminAuthShell() {
  return (
    <div className="flex min-h-dvh flex-col bg-white">
      <header className="border-b px-6 py-4">
        <Wordmark to="/admin/login" />
      </header>
      <main className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <Outlet />
        </div>
      </main>
      <footer className="border-t px-6 py-4 text-[13px] text-muted">
        Paysplit {new Date().getFullYear()}. Administrators only. Access is logged.
      </footer>
    </div>
  );
}

function Title({ title, children }: { title: string; children: ReactNode }) {
  useEffect(() => {
    document.title = `${title} · Paysplit Admin`;
  }, [title]);
  return (
    <div className="mb-6 text-center">
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="mt-1 text-[13px] text-muted">{children}</p>
    </div>
  );
}

export function AdminLogin() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { data } = useAdminSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const login = useMutation({
    mutationFn: () => api<Admin>('POST', '/v1/admin/auth/login', { email, password }),
    onSuccess: async (admin) => {
      queryClient.setQueryData(['admin-session'], { admin });
      const next = params.get('next');
      await navigate(next?.startsWith('/admin') ? next : '/admin');
    },
  });
  if (data?.admin && !login.isPending && !login.isSuccess) return <Navigate to="/admin" replace />;
  return (
    <>
      <Title title="Welcome back!">Enter your details to log in to your account</Title>
      {params.get('reset') && (
        <Notice tone="good">Your password was changed. Sign in with the new one.</Notice>
      )}
      <form
        className="mt-3 space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          login.mutate();
        }}
      >
        <Input
          label="Email"
          type="email"
          autoComplete="username"
          placeholder="Enter your email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <PasswordInput
          label="Password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <p className="text-right">
          <Link to="/admin/forgot-password" className="text-[13px] text-brand-ink hover:underline">
            Forgot password
          </Link>
        </p>
        <FormError error={login.error} />
        <Button type="submit" className="w-full" busy={login.isPending}>
          Confirm
        </Button>
      </form>
    </>
  );
}

export function AdminForgot() {
  return (
    <>
      <Title title="Forgot password">We’ll email you a link to choose a new one</Title>
      <ForgotPasswordForm path="/v1/admin/auth/forgot-password" backTo="/admin/login" />
    </>
  );
}

export function AdminReset() {
  return (
    <>
      <Title title="Choose a new password">Other devices will be signed out</Title>
      <ResetPasswordForm path="/v1/admin/auth/reset-password" doneTo="/admin/login?reset=1" />
    </>
  );
}
