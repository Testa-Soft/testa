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
export const REDIRECTED_TTL_SEC = 30 * SECONDS_PER_DAY;
export const UUID_TTL_SEC = 400 * SECONDS_PER_DAY;

export const redirectedName = (experimentId: number | string): string =>
  `${REDIRECTED_COOKIE}_${experimentId}`;
