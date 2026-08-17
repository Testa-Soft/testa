import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SHIELD_STYLE_ID, buildShieldSnippet, raiseShield } from '../shield.ts';

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function shieldStyle(id = DEFAULT_SHIELD_STYLE_ID): HTMLStyleElement | null {
  return document.getElementById(id) as HTMLStyleElement | null;
}

describe('raiseShield', () => {
  it('injects a hiding style into <head> on raise', () => {
    raiseShield();
    const style = shieldStyle();
    expect(style).not.toBeNull();
    expect(style?.textContent).toContain('opacity:0');
    expect(style?.textContent).toContain('body');
  });

  it('reveal() removes the style and is idempotent', () => {
    const shield = raiseShield();
    expect(shield.revealed).toBe(false);
    shield.reveal();
    expect(shield.revealed).toBe(true);
    expect(shieldStyle()).toBeNull();
    // second call is a no-op, doesn't throw
    shield.reveal();
    expect(shieldStyle()).toBeNull();
  });

  it('auto-reveals after the timeout fallback (never leaves content hidden)', () => {
    const shield = raiseShield({ timeoutMs: 3000 });
    expect(shieldStyle()).not.toBeNull();
    vi.advanceTimersByTime(2999);
    expect(shield.revealed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(shield.revealed).toBe(true);
    expect(shieldStyle()).toBeNull();
  });

  it('explicit reveal cancels the timeout (no late double-reveal)', () => {
    const shield = raiseShield({ timeoutMs: 3000 });
    shield.reveal();
    // advancing past the timeout must not throw or re-run
    expect(() => vi.advanceTimersByTime(5000)).not.toThrow();
    expect(shield.revealed).toBe(true);
  });

  it('is idempotent across a double-raise (reuses one style)', () => {
    raiseShield();
    raiseShield();
    expect(document.querySelectorAll(`#${DEFAULT_SHIELD_STYLE_ID}`)).toHaveLength(1);
  });

  it('honours a custom selector + visibility mode + styleId', () => {
    raiseShield({ selector: '#hero', mode: 'visibility', styleId: 'sx' });
    const style = shieldStyle('sx');
    expect(style?.textContent).toContain('#hero');
    expect(style?.textContent).toContain('visibility:hidden');
  });
});

describe('buildShieldSnippet', () => {
  it('produces an inlinable IIFE that raises the shield when evaluated', () => {
    const snippet = buildShieldSnippet({ timeoutMs: 2500 });
    expect(snippet.startsWith('(function()')).toBe(true);
    // Evaluate it as a <head> snippet would.
    // biome-ignore lint/security/noGlobalEval: exercising the emitted head snippet
    eval(snippet);
    expect(shieldStyle()).not.toBeNull();
    expect(
      (window as unknown as { __testa_shield?: { reveal: () => void } }).__testa_shield,
    ).toBeDefined();
  });

  it('the snippet exposes reveal() that clears the style', () => {
    // biome-ignore lint/security/noGlobalEval: exercising the emitted head snippet
    eval(buildShieldSnippet());
    const w = window as unknown as { __testa_shield?: { reveal: () => void } };
    w.__testa_shield?.reveal();
    expect(shieldStyle()).toBeNull();
  });

  it('safely encodes the selector/id (no injection)', () => {
    const snippet = buildShieldSnippet({ selector: '</style><script>', styleId: "a'b" });
    // The hostile-looking values are JSON-encoded string literals, not raw.
    expect(snippet).toContain(JSON.stringify("a'b"));
    expect(snippet).not.toContain('<script>a');
  });
});
