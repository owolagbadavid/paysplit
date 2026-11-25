import { useMutation, useQuery } from '@tanstack/react-query';
import {
  BriefcaseBusiness,
  CheckCircle2,
  GraduationCap,
  Heart,
  House,
  PiggyBank,
  Plane,
  Receipt,
  Shapes,
  Users,
  Wallet as WalletIcon,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import {
  BENEFICIARY_CATEGORIES,
  formatPercent,
  parseMajor,
  parsePercent,
  WALLET_ACCENTS,
  WALLET_CATEGORIES,
} from '@paysplit/core';
import { api, ApiError, get, refreshMoney } from '../lib/api.ts';
import { naira, ordinal, ruleValue, title } from '../lib/format.ts';
import { refreshSession, useUser } from '../lib/session.ts';
import type {
  Beneficiary,
  BeneficiaryDetail,
  LinkedRule,
  Rule,
  RulesOverview,
  Wallet,
} from '../lib/types.ts';
import {
  Button,
  Checkbox,
  cx,
  fieldErrors,
  FormError,
  Input,
  Modal,
  MoneyInput,
  Notice,
  RadioCards,
  Rows,
  Segmented,
  Select,
} from './core.tsx';

const WALLET_ICONS: Record<string, typeof PiggyBank> = {
  savings: PiggyBank,
  emergency: Heart,
  rent: House,
  bills: Receipt,
  education: GraduationCap,
  travel: Plane,
  investment: BriefcaseBusiness,
  other: Shapes,
};

/** Tint for the card and solid for the icon tile, per accent chosen in the wallet form. */
export const ACCENTS: Record<string, { card: string; tile: string; label: string }> = {
  green: { card: 'linear-gradient(180deg,#e4f8e8,#f8fdf9)', tile: '#2c8a3d', label: 'Green' },
  orange: { card: 'linear-gradient(180deg,#fde6dd,#fef8f5)', tile: '#d9541e', label: 'Orange' },
  purple: { card: 'linear-gradient(180deg,#ece3fd,#faf7ff)', tile: '#7c3aed', label: 'Purple' },
  blue: { card: 'linear-gradient(180deg,#dfeefd,#f6faff)', tile: '#1a69b8', label: 'Blue' },
  teal: { card: 'linear-gradient(180deg,#d9f5f1,#f5fcfb)', tile: '#0f766e', label: 'Teal' },
  pink: { card: 'linear-gradient(180deg,#fce4ef,#fff7fa)', tile: '#be2468', label: 'Pink' },
};

export function WalletGlyph({
  wallet,
  className,
}: {
  wallet: Pick<Wallet, 'category' | 'accent'>;
  className?: string;
}) {
  const Icon = WALLET_ICONS[wallet.category] ?? WalletIcon;
  return (
    <span
      aria-hidden
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-lg text-white',
        className ?? 'size-9',
      )}
      style={{ background: ACCENTS[wallet.accent]?.tile ?? '#111' }}
    >
      <Icon className="size-[55%]" />
    </span>
  );
}

const toMajor = (kobo: number | null | undefined) => (kobo ? String(kobo / 100) : '');

export function IncomeForm({
  onDone,
  submitLabel,
  secondary,
}: {
  onDone: () => void;
  submitLabel: string;
  secondary?: ReactNode;
}) {
  const user = useUser();
  const [employer, setEmployer] = useState(user.employer ?? '');
  const [salary, setSalary] = useState(toMajor(user.expectedSalary));
  const [day, setDay] = useState(String(user.salaryDay ?? 28));
  const [error, setError] = useState('');
  const save = useMutation({
    mutationFn: (expectedSalary: number | null) =>
      api('PUT', '/v1/me/income', { employer: employer || null, expectedSalary, salaryDay: Number(day) }),
    onSuccess: async () => {
      await Promise.all([refreshSession(), refreshMoney()]);
      onDone();
    },
  });
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const parsed = salary.trim() ? parseMajor(salary) : null;
        const bad = Boolean(salary.trim()) && !parsed;
        setError(bad ? 'Enter a valid amount' : '');
        if (!bad) save.mutate(parsed);
      }}
    >
      <Input
        label="Employer"
        placeholder="e.g. Talent Nation"
        value={employer}
        onChange={(e) => setEmployer(e.target.value)}
        error={fieldErrors(save.error).employer}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <MoneyInput
          label="Monthly Salary Amount"
          placeholder="850,000"
          value={salary}
          onChange={(e) => setSalary(e.target.value)}
          error={error || fieldErrors(save.error).expectedSalary}
        />
        <Select label="Expected Payday Day of Month" value={day} onChange={(e) => setDay(e.target.value)}>
          {Array.from({ length: 31 }, (_, i) => (
            <option key={i + 1} value={i + 1}>
              {ordinal(i + 1)}
            </option>
          ))}
        </Select>
      </div>
      <p className="text-[13px] text-muted">
        These are estimates for planning. A split only runs when a salary is confirmed. In shorter months, the
        last day is used.
      </p>
      <FormError error={save.error} />
      <div className={cx('grid gap-3', secondary ? 'grid-cols-2' : '')}>
        {secondary}
        <Button type="submit" busy={save.isPending}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

export function WalletForm({
  wallet,
  onSaved,
  single,
  secondary,
}: {
  wallet?: Wallet;
  onSaved: (wallet: Wallet, next: 'close' | 'rule') => void;
  single?: string;
  secondary?: ReactNode;
}) {
  const [form, setForm] = useState({
    name: wallet?.name ?? '',
    category: wallet?.category ?? 'savings',
    accent: wallet?.accent ?? 'green',
    target: toMajor(wallet?.targetAmount),
    description: wallet?.description ?? '',
  });
  const [noTarget, setNoTarget] = useState(wallet ? !wallet.targetAmount : false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: ({ targetAmount }: { targetAmount: number | null; next: 'close' | 'rule' }) =>
      api<Wallet>(wallet ? 'PATCH' : 'POST', wallet ? `/v1/wallets/${wallet.id}` : '/v1/wallets', {
        name: form.name,
        category: form.category,
        accent: form.accent,
        description: form.description || null,
        targetAmount,
      }),
    onSuccess: async (saved, { next }) => {
      await refreshMoney();
      onSaved(saved, next);
    },
  });
  const submit = (next: 'close' | 'rule') => {
    const target = noTarget || !form.target.trim() ? null : parseMajor(form.target);
    const found: Record<string, string> = {};
    if (!form.name.trim()) found.name = 'Enter a wallet name';
    if (!noTarget && form.target.trim() && !target) found.targetAmount = 'Enter a valid amount above zero';
    setErrors(found);
    if (Object.keys(found).length === 0) save.mutate({ targetAmount: target, next });
  };
  const shown = { ...fieldErrors(save.error), ...errors };
  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit(single || wallet ? 'close' : 'rule');
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          label="Wallet Name"
          placeholder="e.g. Children school fees"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          error={shown.name}
          maxLength={60}
          required
        />
        <Select
          label="Select Category"
          value={form.category}
          onChange={(e) => setForm({ ...form, category: e.target.value })}
          required
        >
          {WALLET_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {title(c)}
            </option>
          ))}
        </Select>
        <div>
          <MoneyInput
            label="Budget Target Amount (₦)"
            placeholder="1,500,000"
            value={noTarget ? '' : form.target}
            disabled={noTarget}
            onChange={(e) => setForm({ ...form, target: e.target.value })}
            error={shown.targetAmount}
          />
          <div className="mt-2">
            <Checkbox
              label="No target amount"
              checked={noTarget}
              onChange={(e) => setNoTarget(e.target.checked)}
            />
          </div>
        </div>
        <Select
          label="Accent Color"
          value={form.accent}
          onChange={(e) => setForm({ ...form, accent: e.target.value })}
        >
          {WALLET_ACCENTS.map((a) => (
            <option key={a} value={a}>
              {ACCENTS[a]!.label}
            </option>
          ))}
        </Select>
      </div>
      <Input
        label="Description (optional)"
        value={form.description}
        onChange={(e) => setForm({ ...form, description: e.target.value })}
        maxLength={200}
        hint="A target is for tracking only. It never locks your money."
      />
      <FormError error={save.error} />
      <div className="grid grid-cols-2 gap-3 pt-1">
        {secondary}
        {!single && !wallet && (
          <Button
            variant="outline"
            onClick={() => submit('close')}
            busy={save.isPending && save.variables.next === 'close'}
          >
            Save
          </Button>
        )}
        <Button
          type="submit"
          className={!secondary && (single || wallet) ? 'col-span-2' : ''}
          busy={save.isPending && (Boolean(single) || Boolean(wallet) || save.variables.next === 'rule')}
        >
          {single ?? (wallet ? 'Save changes' : 'Create Rule')}
        </Button>
      </div>
    </form>
  );
}

function useBanks() {
  return useQuery({
    queryKey: ['banks'],
    queryFn: () => get<{ items: { code: string; name: string }[] }>('/v1/banks'),
    staleTime: 3_600_000,
  });
}

export function BeneficiaryForm({
  beneficiary,
  onSaved,
  single,
  secondary,
}: {
  beneficiary?: Beneficiary | BeneficiaryDetail;
  onSaved: (saved: Beneficiary, next: 'close' | 'rule') => void;
  single?: string;
  secondary?: ReactNode;
}) {
  const banks = useBanks();
  const [changing, setChanging] = useState(!beneficiary);
  const [form, setForm] = useState({
    name: beneficiary?.name ?? '',
    category: beneficiary?.category ?? 'family',
    bankCode: '',
    accountNumber: '',
    narration: beneficiary?.narration ?? '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const ready = changing && form.bankCode !== '' && form.accountNumber.length === 10;
  const lookup = useQuery({
    queryKey: ['resolve', form.bankCode, form.accountNumber],
    queryFn: () =>
      api<{ accountName: string }>('POST', '/v1/banks/resolve', {
        bankCode: form.bankCode,
        accountNumber: form.accountNumber,
      }),
    enabled: ready,
    retry: false,
    staleTime: 300_000,
  });
  const accountName = ready ? lookup.data?.accountName : undefined;
  useEffect(() => {
    if (accountName && !form.name)
      setForm((f) => ({ ...f, name: accountName.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) }));
  }, [accountName, form.name]);

  const save = useMutation({
    mutationFn: (_next: 'close' | 'rule') =>
      api<Beneficiary>(
        beneficiary ? 'PATCH' : 'POST',
        beneficiary ? `/v1/beneficiaries/${beneficiary.id}` : '/v1/beneficiaries',
        {
          name: form.name,
          category: form.category,
          narration: form.narration || null,
          ...(changing ? { bankCode: form.bankCode, accountNumber: form.accountNumber } : {}),
        },
      ),
    onSuccess: async (saved, next) => {
      await refreshMoney();
      onSaved(saved, next);
    },
  });
  const submit = (next: 'close' | 'rule') => {
    const found: Record<string, string> = {};
    if (!form.name.trim()) found.name = 'Enter a beneficiary name';
    if (changing && !form.bankCode) found.bankCode = 'Choose a bank';
    if (changing && form.accountNumber.length !== 10)
      found.accountNumber = 'Enter the 10-digit account number';
    setErrors(found);
    if (Object.keys(found).length === 0) save.mutate(next);
  };
  const shown = { ...fieldErrors(save.error), ...errors };
  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit(single || beneficiary ? 'close' : 'rule');
      }}
    >
      {changing ? (
        <>
          <Select
            label="Bank Name"
            value={form.bankCode}
            onChange={(e) => setForm({ ...form, bankCode: e.target.value })}
            error={shown.bankCode ?? (banks.error ? (banks.error as Error).message : undefined)}
            required
          >
            <option value="">{banks.isPending ? 'Loading banks…' : 'e.g. Access Bank'}</option>
            {banks.data?.items.map((b) => (
              <option key={b.code} value={b.code}>
                {b.name}
              </option>
            ))}
          </Select>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Input
                label="Account Number (10 digits)"
                inputMode="numeric"
                autoComplete="off"
                maxLength={10}
                placeholder="e.g. 1234567898"
                value={form.accountNumber}
                onChange={(e) => setForm({ ...form, accountNumber: e.target.value.replace(/\D/g, '') })}
                error={shown.accountNumber ?? (lookup.error ? (lookup.error as Error).message : undefined)}
                required
              />
              <p role="status" className="mt-1.5 min-h-5 text-[13px]">
                {ready && lookup.isFetching && (
                  <span className="text-muted">Looking up the account name…</span>
                )}
                {accountName && (
                  <span className="flex items-center gap-1 font-medium text-good">
                    <CheckCircle2 className="size-4" aria-hidden /> {accountName}
                  </span>
                )}
              </p>
            </div>
            <CategorySelect value={form.category} onChange={(category) => setForm({ ...form, category })} />
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center justify-between rounded-field border p-3 text-[13px]">
            <span>
              {beneficiary!.bankName}, <span className="num">{beneficiary!.accountNumberMasked}</span>
            </span>
            <Button variant="ghost" size="sm" onClick={() => setChanging(true)}>
              Change account
            </Button>
          </div>
          <CategorySelect value={form.category} onChange={(category) => setForm({ ...form, category })} />
        </>
      )}
      <Input
        label="Beneficiary Name"
        placeholder="What you call them"
        value={form.name}
        onChange={(e) => setForm({ ...form, name: e.target.value })}
        error={shown.name}
        maxLength={80}
        required
      />
      <Input
        label="Payment Narration / Reference Note (optional)"
        placeholder="e.g. Payment for rent"
        value={form.narration}
        onChange={(e) => setForm({ ...form, narration: e.target.value })}
        maxLength={80}
      />
      <p className="text-[13px] text-muted">Saving a beneficiary does not send any money.</p>
      <FormError error={save.error} />
      <div className="grid grid-cols-2 gap-3 pt-1">
        {secondary}
        {!single && !beneficiary && (
          <Button
            variant="outline"
            onClick={() => submit('close')}
            busy={save.isPending && save.variables === 'close'}
            disabled={!accountName}
          >
            Save
          </Button>
        )}
        <Button
          type="submit"
          className={!secondary && (single || beneficiary) ? 'col-span-2' : ''}
          disabled={changing && !accountName}
          busy={save.isPending && (Boolean(single) || Boolean(beneficiary) || save.variables === 'rule')}
        >
          {single ?? (beneficiary ? 'Save changes' : 'Create Rule')}
        </Button>
      </div>
    </form>
  );
}

function CategorySelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <Select label="Select Category" value={value} onChange={(e) => onChange(e.target.value)} required>
      {BENEFICIARY_CATEGORIES.map((c) => (
        <option key={c} value={c}>
          {title(c)}
        </option>
      ))}
    </Select>
  );
}

export interface RuleTarget {
  type: 'wallet' | 'beneficiary';
  id: string;
}

type EditableRule = Pick<Rule, 'id' | 'name' | 'method' | 'value' | 'priority' | 'status'> & {
  destinationName: string;
  destinationType: 'wallet' | 'beneficiary';
};

export const toEditable = (
  rule: LinkedRule,
  destinationName: string,
  destinationType: 'wallet' | 'beneficiary',
): EditableRule => ({
  ...rule,
  status: rule.status as Rule['status'],
  destinationName,
  destinationType,
});

/**
 * Rule builder: details first, then a review the owner confirms. Nothing becomes active without that second step,
 * and someone who is not verified yet can only save a draft.
 */
export function RuleForm({
  rule,
  target,
  onDone,
  onExisting,
  doneLabel,
}: {
  rule?: EditableRule;
  target?: RuleTarget | undefined;
  onDone: () => void;
  onExisting?: (ruleId: string) => void;
  doneLabel?: string;
}) {
  const user = useUser();
  const verified = user.kycStatus === 'approved';
  const wallets = useQuery({
    queryKey: ['wallets'],
    queryFn: () => get<{ items: Wallet[] }>('/v1/wallets'),
    enabled: !rule,
  });
  const beneficiaries = useQuery({
    queryKey: ['beneficiaries'],
    queryFn: () => get<{ items: Beneficiary[] }>('/v1/beneficiaries'),
    enabled: !rule,
  });
  const overview = useQuery({ queryKey: ['rules'], queryFn: () => get<RulesOverview>('/v1/rules') });
  const [type, setType] = useState<'wallet' | 'beneficiary'>(
    rule?.destinationType ?? target?.type ?? 'wallet',
  );
  const [destinationId, setDestinationId] = useState(target?.id ?? '');
  const [name, setName] = useState(rule?.name ?? '');
  const [method, setMethod] = useState<'fixed' | 'percentage'>(rule?.method ?? 'fixed');
  const [raw, setRaw] = useState(
    rule
      ? rule.method === 'fixed'
        ? String(rule.value / 100)
        : formatPercent(rule.value).replace('%', '')
      : '',
  );
  const [priority, setPriority] = useState(String(rule?.priority ?? 1));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [reviewing, setReviewing] = useState(false);

  const ruled = new Set(overview.data?.rules.map((r) => r.destination.id));
  const walletOptions = (wallets.data?.items ?? []).filter((w) => !ruled.has(w.id) || w.id === destinationId);
  const personOptions = (beneficiaries.data?.items ?? []).filter(
    (b) => !ruled.has(b.id) || b.id === destinationId,
  );
  const value = method === 'fixed' ? parseMajor(raw) : parsePercent(raw);
  const destination =
    rule?.destinationName ??
    (type === 'wallet'
      ? walletOptions.find((w) => w.id === destinationId)?.name
      : personOptions.find((b) => b.id === destinationId)?.name);
  const baseline = overview.data?.baseline.amount ?? 0;
  const estimate = value ? (method === 'fixed' ? value : Math.floor((baseline * value) / 10_000)) : 0;

  const save = useMutation({
    mutationFn: async (activate: boolean) => {
      const body = { name, method, value, priority: Number(priority) };
      const saved = rule
        ? await api<Rule>('PUT', `/v1/rules/${rule.id}`, body)
        : await api<Rule>('POST', '/v1/rules', { ...body, destinationType: type, destinationId });
      if (activate && saved.status === 'draft') await api('POST', `/v1/rules/${saved.id}/activate`);
    },
    onSuccess: async () => {
      await refreshMoney();
      onDone();
    },
    onError: (error) => {
      void refreshMoney();
      if (error instanceof ApiError && error.code === 'rule_exists') {
        const existing = (error.details as { ruleId?: string } | undefined)?.ruleId;
        if (existing) onExisting?.(existing);
      }
    },
  });

  const review = () => {
    const found: Record<string, string> = {};
    if (!name.trim()) found.name = 'Enter a rule name';
    if (!rule && !destinationId)
      found.destinationId = type === 'wallet' ? 'Choose a wallet' : 'Choose a beneficiary';
    if (!value)
      found.value =
        method === 'fixed' ? 'Enter a valid amount above zero' : 'Enter a percentage from 0.01 to 100';
    setErrors(found);
    if (Object.keys(found).length === 0) {
      save.reset();
      setReviewing(true);
    }
  };

  if (reviewing && value) {
    return (
      <div className="space-y-4">
        <Rows
          items={[
            ['Rule', name],
            ['Destination', `${destination} (${type === 'wallet' ? 'wallet' : 'beneficiary'})`],
            ['Method', method === 'fixed' ? 'Fixed amount' : 'Percentage of salary'],
            ['Value', ruleValue({ method, value })],
            ['Priority', `${priority} of 10`],
            ...(baseline
              ? ([['From your expected salary', `${naira(estimate)} of ${naira(baseline)}`]] as [
                  string,
                  ReactNode,
                ][])
              : []),
          ]}
        />
        {!verified && (
          <Notice tone="warn">
            You can save this as a draft. Activating it unlocks after you verify your identity.
          </Notice>
        )}
        {verified && (
          <Notice>
            Percentages use your full salary. If what is left cannot cover this rule, it is skipped rather
            than part paid, and the next rule is tried.
          </Notice>
        )}
        <FormError error={save.error} />
        <div className="grid grid-cols-2 gap-3">
          <Button variant="outline" onClick={() => setReviewing(false)} disabled={save.isPending}>
            Edit
          </Button>
          {verified && (!rule || rule.status === 'draft') ? (
            <Button onClick={() => save.mutate(true)} busy={save.isPending && save.variables}>
              {doneLabel ?? 'Activate Split Rule'}
            </Button>
          ) : (
            <Button onClick={() => save.mutate(false)} busy={save.isPending}>
              {rule && rule.status !== 'draft' ? 'Save changes' : 'Save draft'}
            </Button>
          )}
        </div>
        {verified && (!rule || rule.status === 'draft') && (
          <Button
            variant="ghost"
            size="sm"
            className="w-full"
            disabled={save.isPending}
            onClick={() => save.mutate(false)}
          >
            Save as draft instead
          </Button>
        )}
      </div>
    );
  }

  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        review();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          label="Rule Name"
          placeholder="e.g. Mum's monthly allowance"
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={errors.name}
          maxLength={60}
          required
        />
        <Select
          label="Priority"
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
          hint="1 runs first"
        >
          {Array.from({ length: 10 }, (_, i) => (
            <option key={i + 1}>{i + 1}</option>
          ))}
        </Select>
      </div>
      {!rule && (
        <>
          <RadioCards
            label="Destination Type *"
            value={type}
            onChange={(v) => {
              setType(v);
              setDestinationId('');
            }}
            options={[
              {
                value: 'wallet',
                title: 'Move to Wallet',
                detail: 'Savings and budgets',
                icon: <WalletIcon className="size-4" />,
              },
              {
                value: 'beneficiary',
                title: 'Send to Beneficiary',
                detail: 'Bank transfer',
                icon: <Users className="size-4" />,
              },
            ]}
          />
          {type === 'wallet' ? (
            <Select
              label="Select Wallet"
              value={destinationId}
              onChange={(e) => setDestinationId(e.target.value)}
              error={errors.destinationId}
              hint={
                wallets.data && walletOptions.length === 0
                  ? 'Every wallet already has a rule. Create another wallet first.'
                  : undefined
              }
              required
            >
              <option value="">Choose a wallet</option>
              {walletOptions.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name} (current balance {naira(w.balance)})
                </option>
              ))}
            </Select>
          ) : (
            <Select
              label="Select Beneficiary"
              value={destinationId}
              onChange={(e) => setDestinationId(e.target.value)}
              error={errors.destinationId}
              hint={
                beneficiaries.data && personOptions.length === 0
                  ? 'Every beneficiary already has a rule. Add another beneficiary first.'
                  : undefined
              }
              required
            >
              <option value="">Choose a beneficiary</option>
              {personOptions.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name} ({b.bankName} {b.accountNumberMasked})
                </option>
              ))}
            </Select>
          )}
        </>
      )}
      {rule && <Rows items={[['Destination', rule.destinationName]]} />}
      <div>
        <p className="mb-1.5 text-[13px] font-medium">Allocation Method & Value *</p>
        <Segmented
          label="Allocation method"
          value={method}
          onChange={(m) => {
            setMethod(m);
            setRaw('');
            setErrors({});
          }}
          options={[
            ['fixed', 'Fixed amount (₦)'],
            ['percentage', 'Percentage (%)'],
          ]}
        />
        <div className="mt-3">
          {method === 'fixed' ? (
            <MoneyInput
              label="Amount"
              placeholder="30,000"
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              error={errors.value}
              required
            />
          ) : (
            <Input
              label="Percentage of salary"
              inputMode="decimal"
              placeholder="10"
              prefix="%"
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              error={errors.value}
              hint={
                baseline && value
                  ? `About ${naira(estimate)} of ${naira(baseline)}`
                  : 'Always of your full salary, whatever ran before'
              }
              required
            />
          )}
        </div>
      </div>
      <Button type="submit" className="w-full">
        Review rule
      </Button>
    </form>
  );
}

/** Chains a destination form into the rule builder, as the design's Save and Create Rule buttons do. */
export function CreateFlow({
  kind,
  onClose,
}: {
  kind: 'wallet' | 'beneficiary' | 'rule' | null;
  onClose: () => void;
}) {
  const [target, setTarget] = useState<RuleTarget | null>(null);
  useEffect(() => {
    if (!kind) setTarget(null);
  }, [kind]);
  if (!kind) return null;
  if (kind === 'rule' || target) {
    return (
      <Modal
        open
        onClose={onClose}
        title="Create Split Rule"
        subtitle="Configure how your salary is distributed"
      >
        <RuleForm target={target ?? undefined} onDone={onClose} />
      </Modal>
    );
  }
  return kind === 'wallet' ? (
    <Modal open onClose={onClose} title="Create New Wallet">
      <WalletForm
        onSaved={(saved, next) => (next === 'rule' ? setTarget({ type: 'wallet', id: saved.id }) : onClose())}
      />
    </Modal>
  ) : (
    <Modal open onClose={onClose} title="Add Recipient/Beneficiary">
      <BeneficiaryForm
        onSaved={(saved, next) =>
          next === 'rule' ? setTarget({ type: 'beneficiary', id: saved.id }) : onClose()
        }
      />
    </Modal>
  );
}
