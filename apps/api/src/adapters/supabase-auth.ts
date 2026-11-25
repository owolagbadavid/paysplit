import { z } from 'zod';
import { randomToken } from '../lib/crypto.ts';
import { AppError, ProviderError } from '../lib/errors.ts';
import { callProvider } from '../lib/http.ts';
import type { AuthProvider, EmailProof } from '../ports/auth.ts';

const PROVIDER = 'supabase-auth';
const linkSchema = z.object({ id: z.uuid(), hashed_token: z.string(), email_otp: z.string() }).loose();

/** Supabase Auth (GoTrue) through its admin API. PaySplit sends its own emails, so only proofs are requested. */
export class SupabaseAuth implements AuthProvider {
  readonly #baseUrl: string;
  readonly #serviceKey: string;

  constructor(baseUrl: string, serviceKey: string) {
    this.#baseUrl = baseUrl;
    this.#serviceKey = serviceKey;
  }

  async createUser(input: { email: string; password: string }) {
    const result = await this.#call('POST', '/admin/generate_link', { type: 'signup', ...input });
    if (result.status === 422 && code(result.body) === 'email_exists') return 'email_taken' as const;
    const link = linkSchema.parse(this.#ok(result));
    return { authId: link.id };
  }

  async createVerifiedUser(input: { email: string; password: string }) {
    const result = await this.#call('POST', '/admin/users', { ...input, email_confirm: true });
    return { authId: z.object({ id: z.uuid() }).loose().parse(this.#ok(result)).id };
  }

  /**
   * Uses a signup link, because Supabase erases an unconfirmed person's password when a magic link confirms them.
   * The link leaves the password they chose alone: Supabase ignores the one sent here once the user exists.
   */
  async issueVerification(email: string): Promise<EmailProof> {
    const signup = await this.#call('POST', '/admin/generate_link', {
      type: 'signup',
      email,
      password: `${randomToken()}Aa1!`,
    });
    const confirmed = signup.status === 422 && code(signup.body) === 'email_exists';
    const result = confirmed
      ? await this.#call('POST', '/admin/generate_link', { type: 'magiclink', email })
      : signup;
    return toProof(linkSchema.parse(this.#ok(result)));
  }

  async issueRecovery(email: string): Promise<EmailProof | null> {
    const result = await this.#call('POST', '/admin/generate_link', { type: 'recovery', email });
    if (result.status === 404) return null;
    return toProof(linkSchema.parse(this.#ok(result)));
  }

  async redeem(input: { token: string } | { email: string; code: string }, purpose: 'email' | 'recovery') {
    const body =
      'token' in input
        ? { type: purpose, token_hash: input.token }
        : { type: purpose, email: input.email, token: input.code };
    const result = await this.#call('POST', '/verify', body);
    if (result.status === 403 || result.status === 400 || result.status === 404) return null;
    const session = z
      .object({ user: z.object({ id: z.uuid() }).loose() })
      .loose()
      .parse(this.#ok(result));
    return { authId: session.user.id };
  }

  async checkPassword(email: string, password: string) {
    const result = await this.#call('POST', '/token?grant_type=password', { email, password });
    const errorCode = code(result.body);
    if (errorCode === 'invalid_credentials') return 'invalid' as const;
    if (errorCode === 'email_not_confirmed') return 'unverified' as const;
    const session = z
      .object({ user: z.object({ id: z.uuid() }).loose() })
      .loose()
      .parse(this.#ok(result));
    return { authId: session.user.id };
  }

  async setPassword(authId: string, password: string) {
    this.#ok(await this.#call('PUT', `/admin/users/${authId}`, { password }));
  }

  async deleteUser(authId: string) {
    this.#ok(await this.#call('DELETE', `/admin/users/${authId}`));
  }

  #call(method: string, path: string, body?: unknown) {
    return callProvider(PROVIDER, this.#baseUrl + path, {
      method,
      headers: { apikey: this.#serviceKey, authorization: `Bearer ${this.#serviceKey}` },
      body,
      timeoutMs: 15_000,
    });
  }

  #ok(result: { status: number; body: unknown }): unknown {
    if (result.status < 400) return result.body;
    const errorCode = code(result.body);
    if (errorCode === 'weak_password') throw new AppError(422, 'weak_password', 'Choose a stronger password');
    if (errorCode === 'same_password')
      throw new AppError(422, 'same_password', 'Choose a password you have not used before');
    throw new ProviderError(
      PROVIDER,
      'rejected',
      `Auth refused the request (${errorCode ?? result.status})`,
      result.status,
    );
  }
}

function toProof(link: z.infer<typeof linkSchema>): EmailProof {
  return { token: link.hashed_token, code: link.email_otp };
}

function code(body: unknown): string | undefined {
  return z.object({ error_code: z.string() }).safeParse(body).data?.error_code;
}
