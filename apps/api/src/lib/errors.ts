export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new AppError(400, code, message, details);
export const unauthorized = (message = 'Sign in to continue') => new AppError(401, 'unauthorized', message);
export const forbidden = (code: string, message: string) => new AppError(403, code, message);
export const notFound = (what: string) => new AppError(404, 'not_found', `${what} not found`);
export const conflict = (code: string, message: string, details?: unknown) =>
  new AppError(409, code, message, details);
export const unprocessable = (code: string, message: string, details?: unknown) =>
  new AppError(422, code, message, details);
export const unavailable = (message: string) => new AppError(503, 'provider_unavailable', message);

/**
 * Failure talking to a third party.
 * - `rejected`: the provider understood and refused. Nothing happened there.
 * - `unknown`: timeout, network failure or 5xx. It may or may not have happened, so look it up before retrying.
 * - `not_found`: the provider has no record of it.
 * - `throttled`: refused for rate, nothing happened.
 */
export class ProviderError extends Error {
  readonly provider: string;
  readonly kind: 'rejected' | 'unknown' | 'not_found' | 'throttled';
  readonly httpStatus: number | undefined;
  readonly providerCode: string | undefined;

  constructor(
    provider: string,
    kind: ProviderError['kind'],
    message: string,
    httpStatus?: number,
    providerCode?: string,
  ) {
    super(message);
    this.provider = provider;
    this.kind = kind;
    this.httpStatus = httpStatus;
    this.providerCode = providerCode;
  }
}

const UNIQUE_VIOLATION = '23505';

/** Name of the violated unique constraint or index, when that is what went wrong. */
export function uniqueViolation(error: unknown): string | null {
  for (
    let e = error as { code?: string; constraint_name?: string; cause?: unknown } | undefined;
    e;
    e = e.cause as typeof e
  ) {
    if (e.code === UNIQUE_VIOLATION) return e.constraint_name ?? 'unknown';
  }
  return null;
}
