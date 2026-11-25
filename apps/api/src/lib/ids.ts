import { randomBytes } from 'node:crypto';

// Crockford base32: no I, L, O or U, so references survive being read aloud.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function suffix(length: number): string {
  return Array.from(randomBytes(length), (b) => ALPHABET[b % 32]).join('');
}

/** Customer-facing reference such as `PAY-20261125-7K2M9QX4`. */
export function reference(prefix: 'PAY' | 'SAL' | 'SPL', now = new Date()): string {
  return `${prefix}-${now.toISOString().slice(0, 10).replaceAll('-', '')}-${suffix(8)}`;
}
