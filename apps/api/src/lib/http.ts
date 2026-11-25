import { ProviderError } from './errors.ts';

export interface ProviderResponse {
  status: number;
  body: unknown;
}

/**
 * Calls a provider and classifies transport failures. A timeout, dropped connection, 5xx or unreadable body is
 * `unknown`, never `rejected`, because the provider may have acted before the answer was lost.
 */
export async function callProvider(
  provider: string,
  url: string,
  init: { method: string; headers: Record<string, string>; body?: unknown; timeoutMs: number },
): Promise<ProviderResponse> {
  let response: Response;
  let text: string;
  try {
    response = await fetch(url, {
      method: init.method,
      headers: {
        accept: 'application/json',
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(init.timeoutMs),
    });
    text = await response.text();
  } catch (error) {
    throw new ProviderError(provider, 'unknown', `No answer from ${provider}: ${(error as Error).name}`);
  }
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new ProviderError(provider, 'unknown', `${provider} sent an unreadable answer`, response.status);
  }
  if (response.status === 429)
    throw new ProviderError(provider, 'throttled', `${provider} asked us to slow down`, 429);
  if (response.status >= 500)
    throw new ProviderError(
      provider,
      'unknown',
      `${provider} is failing (${response.status})`,
      response.status,
    );
  return { status: response.status, body };
}
