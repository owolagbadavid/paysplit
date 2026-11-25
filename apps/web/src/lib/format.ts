import { formatMoney, formatPercent, SKIP_REASON_TEXT } from '@paysplit/core';

export const money = (kobo: number) => formatMoney(kobo);
/** Whole naira for headline figures, with kobo kept when there are any. */
export const naira = (kobo: number) => formatMoney(kobo).replace(/\.00$/, '');

export function compact(kobo: number): string {
  const value = Math.abs(kobo) / 100;
  if (value >= 1_000_000) return `₦${+(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `₦${+(value / 1000).toFixed(0)}K`;
  return `₦${value}`;
}

export const ruleValue = (rule: { method: string; value: number }) =>
  rule.method === 'fixed' ? naira(rule.value) : formatPercent(rule.value);

export const date = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
export const dateTime = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
/** For calendar dates such as 2026-11-25, which have no time and must not shift by timezone. */
export const calendarDate = (isoDate: string) =>
  new Date(`${isoDate}T12:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
export const monthName = (key: string, style: 'short' | 'long' = 'long') =>
  new Date(`${key}-15T12:00:00Z`).toLocaleDateString('en-GB', {
    month: style,
    year: style === 'short' ? '2-digit' : 'numeric',
    timeZone: 'UTC',
  });

export function ordinal(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${suffix}`;
}

export const title = (value: string) => value.charAt(0).toUpperCase() + value.slice(1).replaceAll('_', ' ');

export function ago(iso: string): string {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  return date(iso);
}

export const TYPE_TEXT: Record<string, string> = {
  salary_received: 'Salary received',
  wallet_allocation: 'Wallet allocation',
  beneficiary_transfer: 'Beneficiary transfer',
  wallet_to_salary: 'Wallet to salary account',
};

export const skipText = (reason: string | null) =>
  reason ? (SKIP_REASON_TEXT[reason] ?? 'Skipped') : 'Skipped';

export function greeting(now = new Date()): string {
  const hour = now.getHours();
  return hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
}
