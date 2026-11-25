export interface EmailProof {
  /** Opaque value for a link. */
  token: string;
  /** Six-digit code for typing. */
  code: string;
}

/** The credential authority. Passwords go straight here and are never stored or logged by PaySplit. */
export interface AuthProvider {
  createUser(input: { email: string; password: string }): Promise<{ authId: string } | 'email_taken'>;
  /** Creates an already-verified account, for administrators. */
  createVerifiedUser(input: { email: string; password: string }): Promise<{ authId: string }>;
  issueVerification(email: string): Promise<EmailProof>;
  issueRecovery(email: string): Promise<EmailProof | null>;
  /** Consumes a link token or a typed code. Null when it is wrong, used or expired. */
  redeem(
    input: { token: string } | { email: string; code: string },
    purpose: 'email' | 'recovery',
  ): Promise<{ authId: string } | null>;
  checkPassword(email: string, password: string): Promise<{ authId: string } | 'invalid' | 'unverified'>;
  setPassword(authId: string, password: string): Promise<void>;
  deleteUser(authId: string): Promise<void>;
}
