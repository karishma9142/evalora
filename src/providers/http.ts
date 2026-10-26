import { ProviderError } from './types.js';

// Shared helper: POST JSON with a timeout and clean error messages.
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs = 60_000,
): Promise<{ json: unknown; latencyMs: number }> {
  const start = performance.now();

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new ProviderError(`Request timed out after ${timeoutMs / 1000}s`);
    }
    throw new ProviderError(`Could not reach the provider: ${(err as Error).message}`);
  }

  const text = await res.text();
  const latencyMs = Math.round(performance.now() - start);

  if (!res.ok) {
    throw new ProviderError(`Provider returned ${res.status}: ${text.slice(0, 300)}`, res.status);
  }
  try {
    return { json: JSON.parse(text), latencyMs };
  } catch {
    throw new ProviderError('Provider returned invalid JSON');
  }
}
