import { useMutation } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { emailSchema, registerSchema, resetPasswordSchema } from '@paysplit/core';
import { api, ApiError, queryClient } from '../lib/api.ts';
import { refreshSession, useSession } from '../lib/session.ts';
import type { User } from '../lib/types.ts';
import {
  Button,
  buttonClass,
  Checkbox,
  cx,
  fieldErrors,
  FormError,
  Input,
  Modal,
  Notice,
  OtpInput,
  PasswordInput,
} from '../ui/core.tsx';

/** First message per field from a Zod check, so the form explains itself before the server is asked. */
export function zodErrors(result: {
  success: boolean;
  error?: { issues: { path: PropertyKey[]; message: string }[] };
}): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of result.error?.issues ?? []) errors[String(issue.path[0] ?? 'form')] ??= issue.message;
  return errors;
}

function AuthModal({
  title,
  subtitle,
  children,
  width,
}: {
  title: string;
  subtitle: ReactNode;
  children: ReactNode;
  width?: string;
}) {
  const navigate = useNavigate();
  useEffect(() => {
    document.title = `${title} · Paysplit`;
  }, [title]);
  return (
    <Modal
      open
      mark
      onClose={() => navigate('/')}
      title={title}
      subtitle={subtitle}
      width={width ?? 'max-w-md'}
    >
      {children}
    </Modal>
  );
}

export function Login() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { data } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const login = useMutation({
    mutationFn: () => api<User>('POST', '/v1/auth/login', { email, password, remember }),
    onSuccess: async (user) => {
      queryClient.clear();
      queryClient.setQueryData(['session'], { user });
      const next = params.get('next');
      await navigate(next?.startsWith('/') && !next.startsWith('//') ? next : '/dashboard');
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'email_unverified')
        void navigate(`/verify-email?email=${encodeURIComponent(email)}&resend=1`);
    },
  });
  if (data?.user && !login.isPending && !login.isSuccess) return <Navigate to="/dashboard" replace />;
  return (
    <AuthModal title="Welcome back!" subtitle="Enter your details to log in to your account">
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
          autoComplete="email"
          placeholder="Enter your email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={fieldErrors(login.error).email}
          required
        />
        <PasswordInput
          label="Password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <div className="flex items-center justify-between">
          <Checkbox
            label="Remember for 30 days"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          <Link to="/forgot-password" className="text-[13px] text-brand-ink hover:underline">
            Forgot password
          </Link>
        </div>
        <FormError error={login.error} />
        <Button type="submit" className="w-full" busy={login.isPending}>
          Confirm
        </Button>
        <p className="text-center text-[13px] text-muted">
          Don’t have an account?{' '}
          <Link to="/register" className="font-medium text-brand-ink hover:underline">
            Create one
          </Link>
        </p>
      </form>
    </AuthModal>
  );
}

export function Register() {
  const navigate = useNavigate();
  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    email: '',
    password: '',
    confirmPassword: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => {
    setForm({ ...form, [key]: e.target.value });
    setErrors(({ [key]: _cleared, ...rest }) => rest);
  };
  const register = useMutation({
    mutationFn: () => api<{ email: string }>('POST', '/v1/auth/register', form),
    onSuccess: ({ email }) => navigate(`/verify-email?email=${encodeURIComponent(email)}`),
  });
  const shown = { ...errors, ...fieldErrors(register.error) };
  return (
    <AuthModal title="Create an account" subtitle="Enter your details to create your account">
      <form
        noValidate
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          const check = registerSchema.safeParse(form);
          setErrors(zodErrors(check));
          if (check.success) register.mutate();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="First Name"
            autoComplete="given-name"
            placeholder="Enter first name"
            value={form.firstName}
            onChange={set('firstName')}
            error={shown.firstName}
            required
          />
          <Input
            label="Last Name"
            autoComplete="family-name"
            placeholder="Enter last name"
            value={form.lastName}
            onChange={set('lastName')}
            error={shown.lastName}
            required
          />
        </div>
        <Input
          label="Email"
          type="email"
          autoComplete="email"
          placeholder="Enter your email"
          value={form.email}
          onChange={set('email')}
          error={shown.email}
          required
        />
        <PasswordInput
          label="Password"
          autoComplete="new-password"
          value={form.password}
          onChange={set('password')}
          error={shown.password}
          showRules
          required
        />
        <PasswordInput
          label="Confirm password"
          autoComplete="new-password"
          value={form.confirmPassword}
          onChange={set('confirmPassword')}
          error={shown.confirmPassword}
          required
        />
        <FormError error={register.error} />
        <Button type="submit" className="w-full" busy={register.isPending}>
          Confirm
        </Button>
        <p className="text-center text-[13px] text-muted">
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-brand-ink hover:underline">
            Sign in
          </Link>
        </p>
      </form>
    </AuthModal>
  );
}

export function VerifyEmail() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token');
  const [email, setEmail] = useState(params.get('email') ?? '');
  const [code, setCode] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const verify = useMutation({
    mutationFn: (body: object) =>
      api<{ next: 'signed_in' | 'set_password'; token?: string }>('POST', '/v1/auth/verify-email', body),
    onSuccess: async (result) => {
      if (result.next === 'set_password')
        return navigate(`/reset-password?verified=1&token=${encodeURIComponent(result.token!)}`, {
          replace: true,
        });
      await refreshSession();
      return navigate('/welcome', { replace: true });
    },
    onError: () => setCode(''),
  });
  const resend = useMutation({
    mutationFn: () => api('POST', '/v1/auth/resend-verification', { email }),
    onSuccess: () => setCooldown(60),
  });

  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (token) verify.mutate({ token });
    else if (params.get('resend') && emailSchema.safeParse(email).success) resend.mutate();
  }, [token, params, email, verify, resend]);
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown(cooldown - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  if (token && verify.isPending) {
    return (
      <AuthModal title="Verifying your email" subtitle="One moment">
        <p role="status" className="py-6 text-center text-muted">
          Checking your link…
        </p>
      </AuthModal>
    );
  }
  return (
    <AuthModal
      title="Please check your email"
      subtitle={email ? `We’ve sent a code to ${email}` : 'Enter your email to get a new code'}
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          verify.mutate({ email, code });
        }}
      >
        {(!params.get('email') || token) && (
          <Input
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        )}
        <OtpInput
          value={code}
          onChange={setCode}
          error={verify.error ? (verify.error as Error).message : undefined}
        />
        <p className="text-center text-[13px] text-muted">
          Didn’t get a code?{' '}
          {cooldown > 0 ? (
            <span role="status">Sent. You can ask again in {cooldown}s.</span>
          ) : (
            <button
              type="button"
              className="font-medium text-brand-ink underline"
              disabled={resend.isPending || !email}
              onClick={() => resend.mutate()}
            >
              Click to resend
            </button>
          )}
        </p>
        <FormError error={resend.error} />
        <Button
          type="submit"
          className="w-full"
          disabled={code.length !== 6 || !email}
          busy={verify.isPending}
        >
          Verify email
        </Button>
      </form>
    </AuthModal>
  );
}

export function Burst() {
  return (
    <div
      className="relative mx-auto flex h-32 w-full items-center justify-center overflow-hidden"
      aria-hidden
    >
      <div
        className="absolute size-72 rounded-full opacity-70"
        style={{
          background: 'repeating-conic-gradient(from 8deg, #eef2f7 0 12deg, transparent 12deg 34deg)',
          mask: 'radial-gradient(circle, #000 20%, transparent 68%)',
        }}
      />
      <span className="relative flex size-20 items-center justify-center rounded-full bg-linear-to-b from-[#06101d] to-[#4a94dd] text-white shadow-lg">
        <Check className="size-10" strokeWidth={3} />
      </span>
    </div>
  );
}

export function Welcome() {
  const navigate = useNavigate();
  const { data, isPending } = useSession();
  if (isPending) return null;
  if (!data?.user) return <Navigate to="/login" replace />;
  return (
    <Modal
      open
      onClose={() => navigate('/dashboard')}
      title={`Welcome to PaySplit, ${data.user.firstName}`}
      hideTitle
      width="max-w-lg"
    >
      <Burst />
      <p className="text-center text-lg font-semibold">Welcome to PaySplit, {data.user.firstName}</p>
      <p className="mx-auto mt-1 max-w-sm text-center text-[13px] text-muted">
        Your email is confirmed. Set up your profile and your salary partitions in a few minutes.
      </p>
      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        {[
          ['Step 1', 'Profile & identity verification', 'BVN or NIN, then a quick selfie'],
          ['Step 2', 'Setup checklist', 'Income, wallets and rules'],
        ].map(([step, title, text]) => (
          <div key={step} className="rounded-xl border p-4">
            <span className="rounded-full bg-strip px-2 py-0.5 text-[12px] text-muted">{step}</span>
            <p className="mt-3 text-[13px] font-semibold">{title}</p>
            <p className="text-[12px] text-muted">{text}</p>
          </div>
        ))}
      </div>
      <div className="mt-5 grid grid-cols-2 gap-3">
        <Link to="/dashboard" className={buttonClass('outline')}>
          Go to dashboard
        </Link>
        <Link to="/onboarding" className={buttonClass()}>
          Continue to KYC
        </Link>
      </div>
    </Modal>
  );
}

export function ForgotPasswordForm({ path, backTo }: { path: string; backTo: string }) {
  const [email, setEmail] = useState('');
  const forgot = useMutation({ mutationFn: () => api('POST', path, { email }) });
  if (forgot.isSuccess) {
    return (
      <div className="space-y-4">
        <Notice tone="good" title="Check your email">
          If {email} has an account, a reset link is on its way. It works once and expires in an hour.
        </Notice>
        <Link to={backTo} className={cx(buttonClass('outline'), 'w-full')}>
          Back to sign in
        </Link>
      </div>
    );
  }
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        forgot.mutate();
      }}
    >
      <Input
        label="Email"
        type="email"
        autoComplete="email"
        placeholder="Enter your email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        error={fieldErrors(forgot.error).email}
        required
      />
      <FormError error={forgot.error} />
      <Button type="submit" className="w-full" busy={forgot.isPending}>
        Send reset link
      </Button>
      <p className="text-center">
        <Link to={backTo} className="text-[13px] text-brand-ink hover:underline">
          Back to sign in
        </Link>
      </p>
    </form>
  );
}

export function ResetPasswordForm({ path, doneTo }: { path: string; doneTo: string }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const reset = useMutation({
    mutationFn: () => api('POST', path, { token, password }),
    onSuccess: () => navigate(doneTo, { replace: true }),
  });
  if (!token)
    return (
      <Notice tone="bad">This link is incomplete. Open the newest reset email and use its button.</Notice>
    );
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const found = zodErrors(resetPasswordSchema.safeParse({ token, password }));
        if (password !== confirm) found.confirm = 'Passwords do not match';
        setErrors(found);
        if (Object.keys(found).length === 0) reset.mutate();
      }}
    >
      {params.get('verified') && (
        <Notice title="Your email is verified">
          You opened the link on another device or browser, so choose your password here to protect your
          account.
        </Notice>
      )}
      <PasswordInput
        label="New password"
        autoComplete="new-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        error={errors.password}
        showRules
      />
      <PasswordInput
        label="Confirm new password"
        autoComplete="new-password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        error={errors.confirm}
      />
      <FormError error={reset.error} />
      <Button type="submit" className="w-full" busy={reset.isPending}>
        Save password
      </Button>
    </form>
  );
}

export function ForgotPassword() {
  return (
    <AuthModal title="Forgot password" subtitle="We’ll email you a link to choose a new one">
      <ForgotPasswordForm path="/v1/auth/forgot-password" backTo="/login" />
    </AuthModal>
  );
}

export function ResetPassword() {
  return (
    <AuthModal title="Choose a new password" subtitle="Other devices will be signed out">
      <ResetPasswordForm path="/v1/auth/reset-password" doneTo="/login?reset=1" />
    </AuthModal>
  );
}
