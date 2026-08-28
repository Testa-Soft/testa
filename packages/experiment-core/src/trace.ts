/**
 * URL decision tracing — opt-in, zero-cost when off.
 *
 * The URL a decision is made against is rewritten several times before anything
 * matches on it (host recovery, framework-param stripping, param merging into a
 * redirect destination), and each rewrite is a place a visitor's query can
 * change shape. When a rule then silently fails to match, or a destination
 * arrives with fewer params than the visitor had, the only useful evidence is
 * the URL AT EACH STAGE — which nothing outside the process can see.
 *
 * This collects that. `beginUrlTrace()` / `endUrlTrace()` bracket a decision;
 * every URL-touching step in between records what it was given and what it
 * produced. Correlation is safe without ids because everything between the two
 * calls is SYNCHRONOUS — `runExperiments`, `resolveGuardRedirect` and
 * `buildRedirectUrl` never await — so two concurrent requests in one isolate
 * cannot interleave into the same buffer.
 *
 * Off by default: with no active buffer `traceUrl` is a single null check, so
 * this costs nothing on the hot path and can ship enabled-by-flag.
 */

/** One URL-touching step: what it saw, what it produced, and why. */
export interface UrlTraceEvent {
  /** Which step recorded this — `strip-params`, `exclusion`, `merge-params`, … */
  stage: string;
  /** The URL (or value) the step was given. */
  in?: string;
  /** The URL (or value) it produced. */
  out?: string;
  /** Step-specific context: the rule that matched, the mode used, an experiment id. */
  detail?: Record<string, unknown>;
}

let buffer: UrlTraceEvent[] | null = null;

/** Start collecting. Returns nothing; pair with `endUrlTrace` in a `finally`. */
export function beginUrlTrace(): void {
  buffer = [];
}

/** Stop collecting and return what was recorded (empty when tracing was off). */
export function endUrlTrace(): UrlTraceEvent[] {
  const collected = buffer ?? [];
  buffer = null;
  return collected;
}

/** True while a trace is being collected — lets callers skip building `detail`. */
export function isUrlTracing(): boolean {
  return buffer !== null;
}

/** Record a step. No-op (one null check) unless a trace is active. */
export function traceUrl(event: UrlTraceEvent): void {
  if (buffer === null) return;
  buffer.push(event);
}

/**
 * The query keys of a URL, for spotting a stage that dropped some. Returns null
 * for anything unparseable rather than throwing — tracing must never be able to
 * break the decision it is observing.
 */
export function queryKeysOf(url: string): string[] | null {
  try {
    // `forEach`, not `keys()` — experiment-core compiles under three different
    // lib sets and `URLSearchParams` differs between them (see redirect/url.ts).
    const keys: string[] = [];
    new URL(url, 'https://placeholder.invalid').searchParams.forEach((_value, key) => {
      keys.push(key);
    });
    return keys;
  } catch {
    return null;
  }
}
