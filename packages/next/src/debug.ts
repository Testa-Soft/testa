/**
 * Opt-in debug tracing — `debug: true` on the proxy, or `TESTA_DEBUG=1` env.
 *
 * Emits ONE compact JSON decision trace per request, two ways at once:
 *   - a `[testa] {…}` console line — lands wherever the runtime logs go
 *     (Vercel function logs, `next start` stdout, the pod's logs), and
 *   - an `x-testa-debug` RESPONSE header — visible in the browser network
 *     tab and `curl -sI`, so production issues are debuggable WITHOUT log
 *     access (the class of bug this exists for: "why didn't my experiment
 *     fire on this stack?" — wrong resolved URL, method bypass, no config).
 *
 * Off by default and meant for diagnosis, not to stay on: the header exposes
 * experiment internals (ids, variation picks, visitor id) to anyone who can
 * see the response.
 */

/** Response header carrying the JSON `DebugTrace` when debug is enabled. */
export const DEBUG_HEADER = 'x-testa-debug';

/** One request's decision, JSON-serialized into the log line + header. */
export interface DebugTrace {
  /** The URL the decision ran against — resolved public URL (raw on bypass). */
  url: string;
  /** Which mechanism produced the public host — see url-resolver.ts. */
  urlSource?: string;
  /** Why the request was passed through untouched, when it was. */
  bypass?: 'method' | 'path' | 'bot' | 'no-config';
  /** Request method, included on method bypasses. */
  method?: string;
  /**
   * Compute-but-never-commit requests: an App-Router/Speculation-Rules
   * prefetch, or a HEAD (curl -I, uptime monitors). A redirect may still be
   * returned, but no cookie is written and no exposure fires.
   */
  speculative?: 'prefetch' | 'head';
  visitor?: string;
  /**
   * Present when the request had NO `_testa_uuid` but did carry other cookies —
   * i.e. cookies work for this client and ours went missing, so this visitor is
   * being re-bucketed and may land in the other group. The number is how many
   * other cookies came with the request. See `VisitorCookieState`.
   */
  cookieLoss?: number;
  configHash?: string;
  applied?: ReadonlyArray<{ experiment: number; variation: number; first: boolean }>;
  redirect?: string;
  shield?: boolean;
}

export type DebugEmitter = (res: { headers: Headers }, trace: DebugTrace) => void;

/**
 * The emitter, or undefined when disabled — call sites use `emit?.(res, {…})`,
 * whose arguments are never even evaluated on the disabled path.
 */
export function createDebugEmitter(enabled: boolean): DebugEmitter | undefined {
  if (!enabled) return undefined;
  return (res, trace) => {
    const line = JSON.stringify(trace);
    try {
      res.headers.set(DEBUG_HEADER, line);
    } catch {
      // Some response shapes have immutable headers — the console line still fires.
    }
    // The debug facility itself (explicitly opted into) — not stray logging.
    console.debug(`[testa] ${line}`);
  };
}

/** `TESTA_DEBUG=1|true` (case-insensitive) enables tracing without a code change. */
export function envDebugEnabled(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return v === '1' || v === 'true';
}
