/** Amounts are whole minor units (kobo for NGN). Floating point never holds money. */
export type Minor = bigint;

export const BPS_SCALE = 10_000n;

/** Upper bound accepted from clients: ₦1 trillion, far inside the safe integer range once in kobo. */
export const MAX_MINOR = 100_000_000_000_000;

/** Share of `base` for a rate in basis points, rounded down so the parts can never exceed the whole. */
export function shareOf(base: Minor, bps: number): Minor {
  if (!Number.isInteger(bps) || bps < 0) throw new RangeError(`Invalid basis points: ${bps}`);
  if (base < 0n) throw new RangeError('Base amount cannot be negative');
  return (base * BigInt(bps)) / BPS_SCALE;
}

/** Parses a typed decimal such as "1,250.50" into minor units, or null when it is not a valid amount. */
export function parseMajor(input: string): number | null {
  const cleaned = input.replace(/[,\s₦]/g, '');
  const match = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;
  const minor = Number(BigInt(match[1]!) * 100n + BigInt((match[2] ?? '').padEnd(2, '0')));
  return minor <= MAX_MINOR ? minor : null;
}

/** Parses a typed percentage such as "12.5" into basis points, or null when it is not valid. */
export function parsePercent(input: string): number | null {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(input.replace(/[%\s]/g, ''));
  if (!match) return null;
  const bps = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return bps <= 10_000 ? bps : null;
}

export function formatPercent(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const fraction = String(bps % 100)
    .padStart(2, '0')
    .replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''}%`;
}

const SYMBOLS: Record<string, string> = { NGN: '₦' };

/** Formats minor units without going through floating point. */
export function formatMoney(minor: number | bigint, currency = 'NGN'): string {
  const value = BigInt(minor);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cents = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${SYMBOLS[currency] ?? `${currency} `}${whole}.${cents}`;
}

/** Narrows a bigint to a JSON-safe integer, refusing to lose precision silently. */
export function toJsonMinor(value: bigint): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError('Amount exceeds the safe integer range');
  return n;
}
