/**
 * Anti-flicker shield.
 *
 * DOM experiments mutate content the server already rendered (control), so
 * there's an unavoidable control→variant window unless we hide the content
 * until the variation is applied. This is the industry-standard approach
 * (VWO/Optimizely "smart code"): synchronously inject a hiding style as early
 * as possible, then reveal once apply completes — with a hard timeout fallback
 * so a slow or broken apply can NEVER leave the page permanently blank.
 *
 * Two forms:
 *   - `raiseShield()` — the runtime primitive (call it, get a `reveal()` back).
 *   - `buildShieldSnippet()` — the same logic as an inlinable `<head>` IIFE for
 *     SSR frameworks (Next.js), where a React effect would run too late to beat
 *     first paint. The snippet parks `reveal` on `window.__testa_shield`.
 *
 * `opacity: 0` (not `display:none`/`visibility`) is the default: it keeps layout
 * so revealing doesn't reflow, and it still fully hides text/images.
 */

export type ShieldMode = 'opacity' | 'visibility';

export interface ShieldOptions {
  /** CSS selector to hide until reveal. Default `'body'`. */
  selector?: string;
  /**
   * Hard fallback (ms) after which the shield auto-reveals no matter what, so a
   * failed apply never leaves content hidden. Default 4000.
   */
  timeoutMs?: number;
  /** How to hide. `opacity` keeps layout (no reflow on reveal). Default `opacity`. */
  mode?: ShieldMode;
  /** `<style>` element id — makes raising idempotent and reveal targeted. */
  styleId?: string;
}

export interface Shield {
  /** Reveal the shielded content. Idempotent; also cancels the timeout. */
  reveal: () => void;
  /** True once revealed (by call or timeout). */
  readonly revealed: boolean;
}

export const DEFAULT_SHIELD_STYLE_ID = '__testa_shield';
const DEFAULT_SELECTOR = 'body';
const DEFAULT_TIMEOUT_MS = 4000;

function hideRule(selector: string, mode: ShieldMode): string {
  return mode === 'visibility'
    ? `${selector}{visibility:hidden !important}`
    : `${selector}{opacity:0 !important}`;
}

/**
 * Raise the shield now. Injects the hiding `<style>` and arms the timeout.
 * No-op (returns an already-revealed shield) when there's no DOM.
 */
export function raiseShield(opts: ShieldOptions = {}): Shield {
  const selector = opts.selector ?? DEFAULT_SELECTOR;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const mode = opts.mode ?? 'opacity';
  const styleId = opts.styleId ?? DEFAULT_SHIELD_STYLE_ID;

  if (typeof document === 'undefined') {
    return { reveal: () => undefined, revealed: true };
  }

  // Idempotent: reuse an existing shield style (e.g. a head snippet already
  // raised it) rather than stacking a second one.
  let style = document.getElementById(styleId) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = styleId;
    style.textContent = hideRule(selector, mode);
    // `<head>` may not exist yet if called very early; fall back to <html>.
    (document.head ?? document.documentElement).appendChild(style);
  }

  let revealed = false;
  const reveal = (): void => {
    if (revealed) return;
    revealed = true;
    clearTimeout(timer);
    document.getElementById(styleId)?.remove();
  };
  // Armed before any reveal() can run, so the closure reference is always ready.
  const timer = setTimeout(reveal, timeoutMs);

  return {
    get revealed() {
      return revealed;
    },
    reveal,
  };
}

/**
 * The shield as a self-contained IIFE string to inline in a document `<head>`
 * (SSR/Next.js), where it runs before body paint. It raises the shield and
 * exposes `window.__testa_shield = { reveal }` for the apply code to call.
 *
 * The string is static per options and safe to inline (no interpolation of
 * untrusted input — selector/id are author-controlled config).
 */
export function buildShieldSnippet(opts: ShieldOptions = {}): string {
  const selector = opts.selector ?? DEFAULT_SELECTOR;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const mode = opts.mode ?? 'opacity';
  const styleId = opts.styleId ?? DEFAULT_SHIELD_STYLE_ID;
  const rule = hideRule(selector, mode);

  // Kept dependency-free and tiny so it can live inline in <head>.
  return `(function(){try{var d=document;if(d.getElementById(${json(styleId)}))return;var s=d.createElement('style');s.id=${json(styleId)};s.textContent=${json(rule)};(d.head||d.documentElement).appendChild(s);var done=false;function reveal(){if(done)return;done=true;if(t)clearTimeout(t);var e=d.getElementById(${json(styleId)});if(e)e.remove();}var t=setTimeout(reveal,${Number(timeoutMs)});window.__testa_shield={reveal:reveal};}catch(e){}})();`;
}

/** JSON-encode a string for safe embedding in the snippet. */
function json(v: string): string {
  return JSON.stringify(v);
}
