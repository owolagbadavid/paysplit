import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  Eye,
  EyeOff,
  Info,
  Loader2,
  RotateCcw,
  SkipForward,
  Undo2,
  X,
  XCircle,
} from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { Link } from 'react-router';
import { PASSWORD_RULES } from '@paysplit/core';
import { ApiError } from '../lib/api.ts';

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

export function Logo({ mono = false, className }: { mono?: boolean; className?: string }) {
  const fill = mono ? 'currentColor' : 'var(--color-brand)';
  return (
    <svg viewBox="0 0 32 32" className={cx('size-7', className)} aria-hidden="true">
      <path fill={fill} d="M10 2h12l8 8v12l-8 8H10l-8-8V10z" />
      <path stroke="#fff" strokeWidth="2.6" strokeLinecap="round" d="M9 23 23 9" />
      <circle cx="4.6" cy="27.4" r="2" fill={fill} />
      <circle cx="27.4" cy="4.6" r="2" fill={fill} />
    </svg>
  );
}

export function Wordmark({ to = '/', className }: { to?: string; className?: string }) {
  return (
    <Link to={to} className={cx('flex items-center gap-2 font-semibold', className)}>
      <Logo />
      Paysplit
    </Link>
  );
}

const VARIANTS = {
  primary: 'bg-brand text-on-brand hover:bg-brand-hover disabled:bg-line disabled:text-muted',
  outline: 'border border-line-strong bg-white text-ink hover:bg-strip disabled:text-muted',
  brandOutline: 'border border-brand bg-white text-brand-ink hover:bg-brand-wash disabled:text-muted',
  ghost: 'text-brand-ink hover:bg-brand-wash disabled:text-muted',
  dark: 'border border-white/30 bg-black/30 text-white hover:bg-white/10',
  danger: 'bg-bad text-white hover:bg-[#971c13] disabled:bg-line disabled:text-muted',
} as const;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof VARIANTS;
  size?: 'sm' | 'md' | 'lg';
  busy?: boolean;
  icon?: ReactNode;
}

const SIZES = { sm: 'h-9 px-3 text-[13px]', md: 'h-11 px-4', lg: 'h-12 px-5' };
export const buttonClass = (variant: keyof typeof VARIANTS = 'primary', size: keyof typeof SIZES = 'md') =>
  cx(
    'inline-flex items-center justify-center gap-2 rounded-field font-medium whitespace-nowrap transition-colors',
    VARIANTS[variant],
    SIZES[size],
  );

export function Button({
  variant = 'primary',
  size = 'md',
  busy,
  icon,
  children,
  className,
  type = 'button',
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cx(buttonClass(variant, size), className)}
      {...rest}
    >
      {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}

export function IconButton({
  label,
  children,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx(
        'inline-flex size-9 items-center justify-center rounded-lg text-ink hover:bg-strip disabled:text-line-strong',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

const FIELD =
  'h-11 w-full rounded-field border bg-white px-3.5 text-ink transition-colors focus:border-brand-ink focus:outline-2 focus:outline-brand-soft disabled:bg-strip disabled:text-muted';

export function Field({
  label,
  error,
  hint,
  required,
  children,
  className,
}: {
  label: string;
  error?: string | undefined;
  hint?: ReactNode;
  required?: boolean;
  children: (ids: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
  className?: string;
}) {
  const id = useId();
  const describedBy = [error && `${id}-error`, hint && `${id}-hint`].filter(Boolean).join(' ') || undefined;
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1.5 block text-[13px] font-medium">
        {label}
        {required && <span aria-hidden> *</span>}
      </label>
      {children({ id, describedBy, invalid: Boolean(error) })}
      {hint && (
        <p id={`${id}-hint`} className="mt-1.5 text-[13px] text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="mt-1.5 flex items-center gap-1.5 text-[13px] text-bad">
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
          {error}
        </p>
      )}
    </div>
  );
}

type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  error?: string | undefined;
  hint?: ReactNode;
  prefix?: ReactNode;
  wrapClass?: string;
};

export function Input({ label, error, hint, prefix, wrapClass, className, required, ...rest }: InputProps) {
  return (
    <Field
      label={label}
      error={error}
      hint={hint}
      {...(required ? { required } : {})}
      {...(wrapClass ? { className: wrapClass } : {})}
    >
      {({ id, describedBy, invalid }) => (
        <div className="relative">
          {prefix && (
            <span className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-muted">
              {prefix}
            </span>
          )}
          <input
            id={id}
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
            required={required}
            className={cx(
              FIELD,
              invalid ? 'border-bad' : 'border-field-line',
              prefix ? 'pl-9' : '',
              className,
            )}
            {...rest}
          />
        </div>
      )}
    </Field>
  );
}

export function PasswordInput({
  label,
  error,
  hint,
  showRules,
  value,
  ...rest
}: InputProps & { value: string; showRules?: boolean }) {
  const [visible, setVisible] = useState(false);
  return (
    <div>
      <Field label={label} error={error} hint={hint}>
        {({ id, describedBy, invalid }) => (
          <div className="relative">
            <input
              id={id}
              type={visible ? 'text' : 'password'}
              value={value}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              className={cx(FIELD, 'pr-11', invalid ? 'border-bad' : 'border-field-line')}
              {...rest}
            />
            <button
              type="button"
              onClick={() => setVisible(!visible)}
              aria-label={visible ? 'Hide password' : 'Show password'}
              className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-muted hover:text-ink"
            >
              {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
        )}
      </Field>
      {showRules && (
        <ul className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[12px]" aria-label="Password requirements">
          {PASSWORD_RULES.map((rule) => {
            const met = rule.test(value);
            return (
              <li key={rule.id} className={cx('flex items-center gap-1.5', met ? 'text-good' : 'text-muted')}>
                {met ? (
                  <Check className="size-3.5" aria-hidden />
                ) : (
                  <span className="mx-1 size-1.5 rounded-full bg-line-strong" aria-hidden />
                )}
                {rule.label}
                <span className="sr-only">{met ? ', met' : ', not met'}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function Select({
  label,
  error,
  hint,
  children,
  className,
  required,
  wrapClass,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & {
  label: string;
  error?: string | undefined;
  hint?: ReactNode;
  wrapClass?: string;
}) {
  return (
    <Field
      label={label}
      error={error}
      hint={hint}
      {...(required ? { required } : {})}
      {...(wrapClass ? { className: wrapClass } : {})}
    >
      {({ id, describedBy, invalid }) => (
        <select
          id={id}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          className={cx(FIELD, invalid ? 'border-bad' : 'border-field-line', className)}
          {...rest}
        >
          {children}
        </select>
      )}
    </Field>
  );
}

/** Text entry for money. The caller keeps the typed string and converts it with parseMajor. */
export function MoneyInput(props: Omit<InputProps, 'prefix' | 'inputMode'>) {
  return <Input inputMode="decimal" autoComplete="off" prefix="₦" {...props} />;
}

export function Checkbox({ label, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className="flex min-h-6 items-center gap-2 text-[13px]">
      <input type="checkbox" className="size-4 accent-brand-ink" {...rest} />
      {label}
    </label>
  );
}

export function Toggle({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div>
        <p id={id} className="font-medium">
          {label}
        </p>
        {description && <p className="text-[13px] text-muted">{description}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={id}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx(
          'relative h-6 w-11 shrink-0 rounded-full transition-colors',
          checked ? 'bg-brand-ink' : 'bg-field-line',
          disabled && 'opacity-50',
        )}
      >
        <span
          className={cx(
            'absolute top-0.5 left-0.5 size-5 rounded-full bg-white transition-transform',
            checked && 'translate-x-5',
          )}
        />
      </button>
    </div>
  );
}

export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  className,
}: {
  label: string;
  options: readonly (readonly [T, string])[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cx('inline-flex max-w-full overflow-x-auto rounded-lg border bg-strip p-0.5', className)}
    >
      {options.map(([key, text]) => (
        <button
          key={key}
          type="button"
          aria-pressed={value === key}
          onClick={() => onChange(key)}
          className={cx(
            'min-h-8 rounded-md px-3 text-[13px] whitespace-nowrap',
            value === key ? 'bg-white font-semibold shadow-sm' : 'text-muted hover:text-ink',
          )}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

/** Two large choices side by side, such as wallet or beneficiary. */
export function RadioCards<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled,
}: {
  label: string;
  options: { value: T; title: string; detail: string; icon?: ReactNode; disabled?: boolean }[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const name = useId();
  return (
    <fieldset disabled={disabled}>
      <legend className="mb-1.5 text-[13px] font-medium">{label}</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        {options.map((o) => (
          <label
            key={o.value}
            className={cx(
              'flex cursor-pointer items-center gap-3 rounded-field border p-3 has-focus-visible:outline-2 has-focus-visible:outline-brand-ink',
              value === o.value ? 'border-ink ring-1 ring-ink' : 'border-line-strong',
              (o.disabled || disabled) && 'cursor-not-allowed opacity-60',
            )}
          >
            {o.icon && (
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-strip">
                {o.icon}
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-semibold">{o.title}</span>
              <span className="block text-[12px] text-muted">{o.detail}</span>
            </span>
            <input
              type="radio"
              name={name}
              className="size-4 accent-ink"
              checked={value === o.value}
              disabled={o.disabled}
              onChange={() => onChange(o.value)}
            />
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function OtpInput({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
}) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const set = (index: number, raw: string) => {
    const digits = raw.replace(/\D/g, '');
    if (!digits) return onChange(value.slice(0, index) + value.slice(index + 1));
    const next = (value.slice(0, index) + digits + value.slice(index + digits.length)).slice(0, 6);
    onChange(next);
    refs.current[Math.min(5, index + digits.length)]?.focus();
  };
  return (
    <fieldset>
      <legend className="sr-only">6-digit verification code</legend>
      <div className="flex justify-center gap-2">
        {Array.from({ length: 6 }, (_, i) => (
          <input
            key={i}
            ref={(el) => {
              refs.current[i] = el;
            }}
            inputMode="numeric"
            autoComplete={i === 0 ? 'one-time-code' : 'off'}
            aria-label={`Digit ${i + 1}`}
            aria-invalid={Boolean(error) || undefined}
            value={value[i] ?? ''}
            onChange={(e) => set(i, e.target.value)}
            onFocus={(e) => e.target.select()}
            onKeyDown={(e) => {
              if (e.key === 'Backspace' && !value[i]) refs.current[i - 1]?.focus();
            }}
            onPaste={(e) => {
              e.preventDefault();
              set(i, e.clipboardData.getData('text'));
            }}
            className={cx(
              'num size-12 rounded-field border text-center text-lg font-semibold focus:border-brand-ink focus:outline-2 focus:outline-brand-soft',
              error ? 'border-bad' : 'border-field-line',
            )}
          />
        ))}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-center text-[13px] text-bad">
          {error}
        </p>
      )}
    </fieldset>
  );
}

type Tone = 'good' | 'warn' | 'bad' | 'neutral' | 'info';
const TONES: Record<Tone, string> = {
  good: 'bg-good-soft text-good',
  warn: 'bg-warn-soft text-warn',
  bad: 'bg-bad-soft text-bad',
  neutral: 'bg-[#eef1f4] text-[#414a55]',
  info: 'bg-brand-soft text-brand-ink',
};

export function Badge({
  tone = 'neutral',
  icon,
  children,
}: {
  tone?: Tone;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[12px] font-medium whitespace-nowrap',
        TONES[tone],
      )}
    >
      {icon}
      {children}
    </span>
  );
}

const STATUS: Record<string, [Tone, string, typeof Check]> = {
  success: ['good', 'Success', CheckCircle2],
  successful: ['good', 'Successful', CheckCircle2],
  confirmed: ['good', 'Confirmed', CheckCircle2],
  active: ['good', 'Active', CheckCircle2],
  approved: ['good', 'Verified', CheckCircle2],
  passed: ['good', 'Approved', CheckCircle2],
  split: ['good', 'Split', CheckCircle2],
  pending: ['info', 'Pending', Clock],
  provisioning: ['info', 'Setting up', Clock],
  submitting: ['info', 'Submitting', Clock],
  awaiting: ['info', 'Waiting', Clock],
  awaiting_confirmation: ['info', 'Awaiting confirmation', Clock],
  in_progress: ['info', 'In progress', Clock],
  pending_review: ['info', 'Pending review', Clock],
  in_review: ['info', 'In review', Clock],
  reviewed: ['good', 'Approved by review', CheckCircle2],
  retrying: ['warn', 'Retrying', RotateCcw],
  partially_completed: ['warn', 'Partially completed', AlertTriangle],
  action_required: ['warn', 'Action required', AlertTriangle],
  reverification_required: ['warn', 'Re-verification required', AlertTriangle],
  held: ['warn', 'Held for Run Now', AlertTriangle],
  no_rules: ['neutral', 'No active rules', Info],
  not_eligible: ['warn', 'Not eligible', AlertTriangle],
  paused: ['neutral', 'Paused', Clock],
  draft: ['neutral', 'Draft', Info],
  skipped: ['neutral', 'Skipped', SkipForward],
  not_started: ['neutral', 'Not started', Info],
  superseded: ['neutral', 'Replaced', Info],
  expired: ['neutral', 'Expired', Info],
  reversed: ['bad', 'Reversed', Undo2],
  failed: ['bad', 'Failed', XCircle],
  rejected: ['bad', 'Rejected', XCircle],
};

/** Status as colour, icon and words together, never colour alone. */
export function Status({ value }: { value: string }) {
  const [tone, text, Icon] = STATUS[value] ?? ['neutral', value, Info];
  return (
    <Badge tone={tone as Tone} icon={<Icon className="size-3" aria-hidden />}>
      {text}
    </Badge>
  );
}

export function Panel({
  title,
  actions,
  children,
  className,
  flush,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  flush?: boolean;
}) {
  return (
    <section className={cx('min-w-0 rounded-card border bg-strip p-1.5', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
          {title && <h2 className="text-[15px] font-medium">{title}</h2>}
          {actions && <div className="flex max-w-full min-w-0 flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cx('rounded-xl border bg-white', !flush && 'p-4')}>{children}</div>
    </section>
  );
}

export function Tile({
  label,
  value,
  note,
  aside,
  to,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  aside?: ReactNode;
  to?: string;
}) {
  const body = (
    <>
      <span className="flex items-center justify-between gap-2 text-[13px] text-[#3a4450]">
        {label}
        {to && <ChevronRight className="size-4" aria-hidden />}
      </span>
      <span className="num mt-5 block text-[22px] leading-tight font-semibold tracking-tight">{value}</span>
      <span className="mt-1.5 flex min-h-6 flex-wrap items-center justify-between gap-2 text-[12px] text-muted">
        <span>{note}</span>
        {aside}
      </span>
    </>
  );
  return to ? (
    <Link to={to} className="tile block p-4 transition-shadow hover:shadow-md">
      {body}
    </Link>
  ) : (
    <div className="tile p-4">{body}</div>
  );
}

export function PageHeader({
  title,
  crumbs = [],
  actions,
}: {
  title: string;
  crumbs?: { label: string; to?: string }[];
  actions?: ReactNode;
}) {
  useEffect(() => {
    document.title = `${title} · Paysplit`;
  }, [title]);
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-[22px] font-medium tracking-tight">{title}</h1>
        {crumbs.length > 0 && (
          <nav aria-label="Breadcrumb" className="mt-1">
            <ol className="flex flex-wrap items-center gap-2 text-[13px] text-muted">
              {crumbs.map((c, i) => (
                <li key={c.label} className="flex items-center gap-2">
                  {i > 0 && <span aria-hidden>/</span>}
                  {c.to ? (
                    <Link to={c.to} className="text-brand-ink hover:underline">
                      {c.label}
                    </Link>
                  ) : (
                    <span aria-current="page">{c.label}</span>
                  )}
                </li>
              ))}
            </ol>
          </nav>
        )}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      {icon && (
        <span className="mb-3 flex size-11 items-center justify-center rounded-xl bg-brand-soft text-brand-ink">
          {icon}
        </span>
      )}
      <p className="font-semibold">{title}</p>
      {children && <p className="mt-1 max-w-sm text-[13px] text-muted">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const message = error instanceof ApiError ? error.message : 'Something went wrong. Try again.';
  return (
    <div role="alert" className="flex flex-col items-center px-6 py-12 text-center">
      <span className="mb-3 flex size-11 items-center justify-center rounded-xl bg-bad-soft text-bad">
        <AlertTriangle className="size-5" aria-hidden />
      </span>
      <p className="font-semibold">We could not load this</p>
      <p className="mt-1 max-w-sm text-[13px] text-muted">{message}</p>
      {retry && (
        <Button variant="outline" size="sm" className="mt-4" onClick={retry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('animate-pulse rounded-lg bg-[#e9eef4]', className)} aria-hidden />;
}

export function Loading({ rows = 5, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <div role="status" className="space-y-3 p-4">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-9" />
      ))}
    </div>
  );
}

interface AsyncLike<T> {
  data: T | undefined;
  error: unknown;
  isPending: boolean;
  refetch: () => unknown;
}

/** Loading, failure and content for one query, so no screen forgets a state. */
export function Async<T>({
  query,
  rows,
  children,
}: {
  query: AsyncLike<T>;
  rows?: number;
  children: (data: T) => ReactNode;
}) {
  if (query.data !== undefined) return <>{children(query.data)}</>;
  if (query.error) return <ErrorState error={query.error} retry={() => void query.refetch()} />;
  return <Loading {...(rows ? { rows } : {})} />;
}

export function Notice({
  tone = 'info',
  title,
  children,
  action,
}: {
  tone?: Tone;
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const Icon =
    tone === 'bad' ? XCircle : tone === 'warn' ? AlertTriangle : tone === 'good' ? CheckCircle2 : Info;
  return (
    <div
      role={tone === 'bad' ? 'alert' : 'status'}
      className={cx('flex flex-wrap items-start gap-3 rounded-field p-3 text-[13px]', TONES[tone])}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div>{children}</div>}
      </div>
      {action}
    </div>
  );
}

export function Pagination({
  page,
  pageSize,
  total,
  onPage,
  noun = 'entries',
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
  noun?: string;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const shown = total === 0 ? 0 : Math.min(pageSize, total - (page - 1) * pageSize);
  const numbers = [...new Set([1, page - 1, page, page + 1, pages])].filter((n) => n >= 1 && n <= pages);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5 text-[13px] text-muted">
      <span>
        Showing {shown} of {total.toLocaleString()} {noun}
      </span>
      {pages > 1 && (
        <nav aria-label="Pages" className="flex items-center gap-1">
          <IconButton label="Previous page" disabled={page <= 1} onClick={() => onPage(page - 1)}>
            <ChevronLeft className="size-4" />
          </IconButton>
          {numbers.map((n, i) => (
            <span key={n} className="flex items-center">
              {i > 0 && n - numbers[i - 1]! > 1 && <span className="px-1">…</span>}
              <button
                type="button"
                aria-current={n === page ? 'page' : undefined}
                aria-label={`Page ${n}`}
                onClick={() => onPage(n)}
                className={cx('size-8 rounded-full', n === page ? 'bg-black text-white' : 'hover:bg-white')}
              >
                {n}
              </button>
            </span>
          ))}
          <IconButton label="Next page" disabled={page >= pages} onClick={() => onPage(page + 1)}>
            <ChevronRight className="size-4" />
          </IconButton>
        </nav>
      )}
    </div>
  );
}

export function SearchInput({
  value,
  onChange,
  label = 'Search',
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (draft === value) return;
    const timer = setTimeout(() => onChange(draft), 350);
    return () => clearTimeout(timer);
  }, [draft, value, onChange]);
  return (
    <input
      type="search"
      aria-label={label}
      placeholder="Search"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      className="h-9 w-40 rounded-lg border border-line-strong bg-white px-3 text-[13px]"
    />
  );
}

/** Native dialog: focus trap, Escape and inert background come from the browser. */
export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  side = 'center',
  width = 'max-w-lg',
  crown = true,
  hideTitle,
  mark,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  mark?: boolean;
  subtitle?: ReactNode;
  children: ReactNode;
  side?: 'center' | 'right';
  width?: string;
  crown?: boolean;
  hideTitle?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  if (!open) return null;
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className={cx(
        'max-h-[92dvh] w-[calc(100%-32px)] overflow-hidden rounded-card bg-white shadow-pop',
        width,
        side === 'right' && 'mt-4 mr-4 sm:mt-6 sm:mr-6',
      )}
    >
      <div className="max-h-[92dvh] overflow-y-auto">
        <div
          className={cx(
            'relative px-6 pt-6 pb-3',
            crown && 'modal-crown',
            side === 'center' ? 'text-center' : 'text-left',
          )}
        >
          {mark && <Logo mono className="mx-auto mb-3 size-9" />}
          <h2
            id={titleId}
            className={cx('pr-6 text-lg font-semibold', side === 'center' && 'pl-6', hideTitle && 'sr-only')}
          >
            {title}
          </h2>
          {subtitle && <p className="mt-1 text-[13px] text-muted">{subtitle}</p>}
          <IconButton label="Close" onClick={onClose} className="absolute top-3 right-3">
            <X className="size-4" />
          </IconButton>
        </div>
        <div className="px-6 pb-6">{children}</div>
      </div>
    </dialog>
  );
}

export function Confirm({
  open,
  onClose,
  onConfirm,
  title,
  children,
  confirmLabel,
  busy,
  danger,
  error,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  busy?: boolean;
  danger?: boolean;
  error?: unknown;
}) {
  return (
    <Modal open={open} onClose={onClose} title={title} width="max-w-sm" crown={false} side="center">
      <div className="text-center text-[13px] text-muted">{children}</div>
      <FormError error={error} />
      <div className="mt-5 grid grid-cols-2 gap-3">
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button variant={danger ? 'danger' : 'primary'} busy={busy ?? false} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}

export function FormError({ error }: { error: unknown }) {
  if (!error) return null;
  const fields = error instanceof ApiError ? Object.keys(error.fields) : [];
  if (fields.length > 0 && !fields.includes('form')) return null;
  return (
    <div className="mt-4">
      <Notice tone="bad">
        {error instanceof ApiError ? error.message : 'Something went wrong. Try again.'}
      </Notice>
    </div>
  );
}

export const fieldErrors = (error: unknown): Record<string, string> =>
  error instanceof ApiError ? error.fields : {};

export function Rows({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="divide-y">
      {items.map(([label, value]) => (
        <div key={label} className="flex items-start justify-between gap-6 py-2.5 text-[13px]">
          <dt className="shrink-0 text-muted">{label}</dt>
          <dd className="text-right font-medium break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const toast = useToast();
  return (
    <IconButton
      label={label}
      onClick={() => {
        navigator.clipboard.writeText(value).then(
          () => toast('Copied'),
          () => toast('Copying is blocked by your browser', 'bad'),
        );
      }}
    >
      <Copy className="size-4" />
    </IconButton>
  );
}

export function Avatar({ name, className }: { name: string; className?: string }) {
  const initials = name
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return (
    <span
      aria-hidden
      className={cx(
        'inline-flex items-center justify-center rounded-full bg-ink font-semibold text-white',
        className ?? 'size-7 text-[11px]',
      )}
    >
      {initials}
    </span>
  );
}

const ToastContext = createContext<(text: string, tone?: 'good' | 'bad') => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<{ id: number; text: string; tone: 'good' | 'bad' }[]>([]);
  const push = useCallback((text: string, tone: 'good' | 'bad' = 'good') => {
    const id = Date.now() + Math.random();
    setItems((all) => [...all, { id, text, tone }]);
    setTimeout(() => setItems((all) => all.filter((t) => t.id !== id)), 5000);
  }, []);
  const value = useMemo(() => push, [push]);
  return (
    <ToastContext value={value}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4"
      >
        {items.map((t) => (
          <div
            key={t.id}
            className={cx(
              'rounded-field px-4 py-2.5 text-[13px] font-medium text-white shadow-pop',
              t.tone === 'bad' ? 'bg-bad' : 'bg-ink',
            )}
          >
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext>
  );
}
