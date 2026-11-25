import { forbidden } from '../lib/errors.ts';
import type { UserRow } from './sessions.ts';

/** The one gate in front of every restricted financial action. Called by services, never only by the interface. */
export function requireVerified(user: UserRow): void {
  if (user.status !== 'active') throw forbidden('account_closed', 'This account is closed');
  if (!user.emailVerifiedAt) throw forbidden('email_unverified', 'Verify your email first');
  if (user.kycStatus !== 'approved')
    throw forbidden('kyc_required', 'Complete identity verification to unlock this');
}
