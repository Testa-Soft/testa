/** Minimal HTTP + polling helpers (real requests only — nothing is stubbed). */

export interface HttpResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  /** Parsed body when it is JSON, else null. */
  readonly json: unknown;
  readonly ms: number;
}

export interface HttpRequest {
  readonly method?: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Objects are JSON-encoded; strings are sent as is. */
  readonly body?: unknown;
  readonly timeoutMs?: number;
}

export class ConnectionError extends Error {}

export async function http(req: HttpRequest): Promise<HttpResponse> {
  const started = performance.now();
  const hasBody = req.body !== undefined;
  const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  let res: Response;
  try {
    res = await fetch(req.url, {
      method: req.method ?? (hasBody ? 'POST' : 'GET'),
      headers: {
        accept: 'application/json',
        ...(hasBody ? { 'content-type': 'application/json' } : {}),
        ...(req.headers ?? {}),
      },
      ...(hasBody ? { body } : {}),
      signal: AbortSignal.timeout(req.timeoutMs ?? 15_000),
    });
  } catch (err) {
    throw new ConnectionError(`${req.method ?? 'GET'} ${req.url}: ${(err as Error).message}`);
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, text, json, ms: performance.now() - started };
}

/** Poll `probe` until it returns a non-undefined value or the timeout passes. */
export async function waitFor<T>(
  what: string,
  probe: () => Promise<T | undefined>,
  opts: {
    readonly timeoutMs?: number;
    readonly intervalMs?: number;
    /** Errors that end the wait immediately instead of being retried. */
    readonly rethrow?: (err: unknown) => boolean;
  } = {},
): Promise<T> {
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (err) {
      if (opts.rethrow?.(err)) throw err;
      lastError = (err as Error).message;
    }
    await Bun.sleep(opts.intervalMs ?? 1_000);
  }
  throw new Error(
    `timed out after ${opts.timeoutMs ?? 60_000} ms waiting for ${what}${lastError ? ` (last error: ${lastError})` : ''}`,
  );
}

/** Field of an unknown JSON object, or undefined. */
export function field(obj: unknown, key: string): unknown {
  if (obj !== null && typeof obj === 'object' && key in obj) {
    return (obj as Record<string, unknown>)[key];
  }
  return undefined;
}
