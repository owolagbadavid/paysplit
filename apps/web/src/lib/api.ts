import { QueryClient } from '@tanstack/react-query';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** Message per field, when the server rejected a form. */
  get fields(): Record<string, string> {
    const fields = (this.details as { fields?: Record<string, string> } | undefined)?.fields;
    return fields ?? {};
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Calls the API. Every failure, including no connection, becomes an ApiError with a message fit to show. */
export async function api<T>(
  method: Method,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: {
        'X-PaySplit-Client': 'web',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(0, 'offline', 'We could not reach PaySplit. Check your connection and try again.');
  }
  const data = response.headers.get('content-type')?.includes('json') ? await response.json() : null;
  if (!response.ok) {
    const error = (data as { error?: { code: string; message: string; details?: unknown } } | null)?.error;
    throw new ApiError(
      response.status,
      error?.code ?? 'error',
      error?.message ?? 'Something went wrong. Try again.',
      error?.details,
    );
  }
  return data as T;
}

export const get = <T>(path: string) => api<T>('GET', path);
export const newKey = () => crypto.randomUUID();

/** Downloads a file the API generates, so a failure shows a message rather than a broken page. */
export async function download(path: string): Promise<void> {
  const response = await fetch(path, { credentials: 'same-origin' }).catch(() => null);
  if (!response?.ok) {
    const error =
      response && response.headers.get('content-type')?.includes('json')
        ? (await response.json()).error
        : null;
    throw new ApiError(
      response?.status ?? 0,
      error?.code ?? 'download_failed',
      error?.message ?? 'The download failed. Try again.',
    );
  }
  const name =
    /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? 'paysplit-download';
  const url = URL.createObjectURL(await response.blob());
  const link = Object.assign(document.createElement('a'), { href: url, download: name });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: (count, error) =>
        count < 2 && (!(error instanceof ApiError) || error.status === 0 || error.status >= 500),
    },
  },
});

/** Refreshes everything that shows money after something that may have moved it. */
export const refreshMoney = () =>
  queryClient.invalidateQueries({
    predicate: ({ queryKey }) =>
      [
        'dashboard',
        'wallets',
        'beneficiaries',
        'rules',
        'splits',
        'transactions',
        'notifications',
        'kyc',
      ].includes(String(queryKey[0])),
  });

export function query(params: Record<string, string | number | undefined | null>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return entries.length ? `?${new URLSearchParams(entries.map(([k, v]) => [k, String(v)]))}` : '';
}
