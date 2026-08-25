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
/**
 * `id` for the CSS-only shield (see {@link buildShieldCss}). Deliberately NOT
 * {@link DEFAULT_SHIELD_STYLE_ID}: the two shields coexist on an SSR page (the
 * CSS one from the server render, the JS one from `raiseShield` after mount)
 * and each must be revealed by its own owner — sharing the id would let the JS
 * shield's timeout rip out a React-owned element.
 */
export const SHIELD_CSS_STYLE_ID = '__testa_shield_css';
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

/** Options for the CSS-only shield. `styleId` is fixed ({@link SHIELD_CSS_STYLE_ID}). */
export type ShieldCssOptions = Pick<ShieldOptions, 'selector' | 'timeoutMs' | 'mode'>;

/**
 * The shield as PURE CSS — no JavaScript at all, for a `<style>` a server can
 * render into the document (`next/head` from a Pages Router `_app`, a template,
 * an `index.html`). The point is timing: server-rendered markup hides content
 * before the browser's first paint, which is the one thing a client shield can
 * never do — a React effect runs after the control content has already been
 * painted, so raising a shield there produces content → blank → variant instead
 * of preventing the flash.
 *
 * The timeout fallback is CSS too, so nothing keeps the page hidden when the
 * JavaScript that should reveal it never arrives (bundle 404, hydration crash,
 * scripts blocked): the hide lives in an ANIMATION which flips to visible at
 * `timeoutMs`. Animated declarations also outrank normal author declarations in
 * the cascade, so this hides the content whether or not the page's own CSS has
 * an opinion about `body`'s opacity — without `!important` on the property,
 * which would beat the animation and break the fallback reveal.
 *
 * Reveal is the owner's job: stop rendering the `<style>` (or remove it), which
 * `<TestaProvider/>` does as soon as the variant is applied.
 */
export function buildShieldCss(opts: ShieldCssOptions = {}): string {
  const selector = opts.selector ?? DEFAULT_SELECTOR;
  const timeoutMs = Number(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const mode = opts.mode ?? 'opacity';
  const name = `${SHIELD_CSS_STYLE_ID}_reveal`;
  const [hidden, shown] =
    mode === 'visibility'
      ? ['visibility:hidden', 'visibility:visible']
      : ['opacity:0', 'opacity:1'];
  // The 99.99% stop keeps the content hidden for the WHOLE window and flips at
  // the very end; the sub-millisecond ramp between the two stops is invisible.
  // `!important` sits on `animation` (not on the hidden property) so the page's
  // own CSS can't cancel the shield, while the animation still wins the cascade.
  return (
    `@keyframes ${name}{0%,99.99%{${hidden}}100%{${shown}}}` +
    `${selector}{animation:${name} ${timeoutMs}ms linear forwards !important}`
  );
}
