/**
 * crobot diagnostic-log URL — 3.3.3 `helpers.sendLog` parity.
 *
 *   GET {host}/log?data=<base64(JSON)>&type=<level>&r=<cachebuster>
 *
 * A root-level, unauthenticated route that answers with a 1×1 PNG and writes
 * the decoded payload to the server log as `TRACKING_PIXEL`, stamped with the
 * caller's IP and server time. Because the response is an image the legacy
 * pixel sends it as `new Image().src`, which is why this returns a URL rather
 * than performing the request: the browser wants an image beacon and the edge
 * runtime wants `fetch`, and only the caller knows which it is.
 *
 * `type` selects the PSR-3 level the server logs at; anything outside the
 * accepted set is coerced to `info` server-side, so a typo downgrades rather
 * than fails.
 */

/** PSR-3 levels the endpoint accepts; others are logged as `info`. */
export type LogLevel =
  | 'debug'
  | 'info'
  | 'notice'
  | 'warning'
  | 'error'
  | 'critical'
  | 'alert'
  | 'emergency';

/**
 * base64 of a UTF-8 JSON payload.
 *
 * `btoa` is Latin-1 only and THROWS on anything outside it — a URL carrying a
 * non-ASCII query param is enough, and the legacy pixel has exactly that bug.
 * Percent-encoding first keeps the input in Latin-1 so any payload survives.
 */
function base64Utf8(value: string): string {
  const latin1 = encodeURIComponent(value).replace(/%([0-9A-F]{2})/g, (_m, hex) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
  return btoa(latin1);
}

/**
 * Build the beacon URL. Returns null when the payload can't be serialized, so
 * a diagnostic can never throw inside the decision it is diagnosing.
 *
 * `nonce` is the cache-buster (3.3.3 uses `Math.random()`); it is a parameter
 * because the edge runtime forbids `Math.random()` in some contexts and tests
 * need a stable URL.
 */
export function buildLogUrl(
  host: string,
  level: LogLevel,
  payload: unknown,
  nonce: string | number,
): string | null {
  try {
    const data = base64Utf8(JSON.stringify(payload));
    const base = host.replace(/\/+$/, '');
    return `${base}/log?data=${encodeURIComponent(data)}&type=${level}&r=${nonce}`;
  } catch {
    return null;
  }
}
