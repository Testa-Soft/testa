/**
 * The `CookieStore` seam — the single abstraction that lets the same decision
 * core run in the browser (pixel, `document.cookie`) and on the server
 * (`@testa-soft/next`, `NextRequest`/`NextResponse`) without either host leaking
 * into the core logic.
 *
 * Implementations MUST make writes visible to subsequent reads within the same
 * request/decision pass (read-through of pending writes). The middleware loops
 * over experiments writing into a single packed `_testa_exp` cookie, so a later
 * `assign()` must see what an earlier one wrote.
 */

export interface CookieSetOptions {
  /** Cookie lifetime in seconds. */
  maxAgeSec: number;
  /**
   * Hide this cookie from JavaScript. Only the server-owned visitor-id copy
   * uses it — see {@link UUID_BACKUP_COOKIE}. Ignored by stores that write
   * through `document.cookie`, which cannot express it.
   */
  httpOnly?: boolean;
}

export interface CookieStore {
  /** Return the cookie value, or null if absent. */
  get(name: string): string | null;
  /** Set the cookie value. Must be reflected by subsequent `get(name)` calls. */
  set(name: string, value: string, opts: CookieSetOptions): void;
}

// ─── shared cookie names + TTLs (kept in parity with the pixel's cookies.ts) ──

export const UUID_COOKIE = '_testa_uuid';
/**
 * Server-owned copy of the visitor id, written `HttpOnly` so JavaScript cannot
 * touch it — the readable `_testa_uuid` is restored from this whenever it goes
 * missing.
 *
 * The visitor id is the only thing that has to survive: bucketing is
 * `hash(visitorId:experimentId)`, so a visitor whose assignment cookie is gone
 * but whose id is intact is re-assigned to the SAME variation. Lose the id and
 * they become a new visitor — counted twice, and free to land in the other
 * group, on the other group's URL.
 *
 * `HttpOnly` is what makes the copy durable: consent tools, extensions and any
 * third-party script clear cookies through `document.cookie`, which cannot see
 * this one. Safari also treats non-HttpOnly cookies as script-writable storage
 * and caps their lifetime well below our 400 days.
 */
export const UUID_BACKUP_COOKIE = '_testa_uuid_s';
/**
 * Consolidated packed experiment-state cookie (task 3.16). This is the v2 data
 * format shared by the middleware AND the v2 pixel (both consume experiment-core),
 * so a visitor's assignment/exclusion is preserved identically no matter which
 * host they hit. Exclusion is stored in here too (excluded flag) — no separate
 * per-experiment cookies.
 */
export const ASSIGNMENT_COOKIE = '_testa_exp';
/** Per-experiment redirect-already-fired dedup marker. */
export const REDIRECTED_COOKIE = '_testa_redirected';

export const SECONDS_PER_HOUR = 60 * 60;
export const SECONDS_PER_DAY = 24 * SECONDS_PER_HOUR;

export const ASSIGNMENT_TTL_SEC = 30 * SECONDS_PER_DAY;
/**
 * Redirect loop-BREAKER window, not persistence. A variant visitor landing on
 * the control URL must be redirected on EVERY visit (the engine already skips
 * when the current URL is the destination) — this guard only exists to break
 * immediate A↔B ping-pong from pathological configs, so it lives seconds.
 * (It was 30 days once, which locked client-side redirects to once-a-month:
 * variant visitors saw the CONTROL page on every later visit.)
 */
export const REDIRECTED_TTL_SEC = 15;
export const UUID_TTL_SEC = 400 * SECONDS_PER_DAY;

export const redirectedName = (experimentId: number | string): string =>
  `${REDIRECTED_COOKIE}_${experimentId}`;
