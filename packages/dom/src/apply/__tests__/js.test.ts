import type { VariationChange } from '@testa-platform/shared-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyJs, applyVariation } from '../index.ts';

declare global {
  // eslint-disable-next-line no-var
  var __testaProbe: string[] | undefined;
}

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  globalThis.__testaProbe = [];
});

afterEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  globalThis.__testaProbe = undefined;
});

const probe = (value: string) => `globalThis.__testaProbe.push(${JSON.stringify(value)});`;

describe('applyJs', () => {
  it('executes the content', () => {
    applyJs(7, { type: 'js', content: probe('ran') });
    expect(globalThis.__testaProbe).toEqual(['ran']);
  });

  it('appends a tagged <script> carrying the variation id', () => {
    applyJs(7, { type: 'js', content: probe('ran') });
    const script = document.querySelector('script[data-testa-js="7"]');
    expect(script).not.toBeNull();
    expect(script?.parentElement).toBe(document.body);
  });

  it('is idempotent — the same content does not run twice', () => {
    const change: VariationChange = { type: 'js', content: probe('ran') };
    applyJs(7, change);
    applyJs(7, change);
    expect(globalThis.__testaProbe).toEqual(['ran']);
    expect(document.querySelectorAll('script[data-testa-js="7"]').length).toBe(1);
  });

  it('different content runs separately', () => {
    applyJs(7, { type: 'js', content: probe('a') });
    applyJs(7, { type: 'js', content: probe('b') });
    expect(globalThis.__testaProbe).toEqual(['a', 'b']);
  });

  it('does not run when the guard rejects the page', () => {
    applyJs(7, { type: 'js', content: probe('ran') }, { guard: () => false });
    expect(globalThis.__testaProbe).toEqual([]);
    expect(document.querySelector('script[data-testa-js="7"]')).toBeNull();
  });

  it('teardown removes the script element', () => {
    const teardown = applyJs(7, { type: 'js', content: probe('ran') });
    teardown();
    expect(document.querySelector('script[data-testa-js="7"]')).toBeNull();
  });
});

describe('applyVariation with a js change', () => {
  it('runs the script after the markup it targets exists, whatever the authored order', () => {
    document.body.innerHTML = '<div id="hero"></div>';

    const changes: VariationChange[] = [
      // Authored first on purpose: the runtime must still sink it to the end.
      {
        type: 'js',
        content:
          'globalThis.__testaProbe.push(document.querySelector("#cta") ? "found" : "missing");',
      },
      { type: 'change_html', selector: '#hero', content: '<button id="cta">Buy</button>' },
    ];

    applyVariation(7, changes);

    expect(globalThis.__testaProbe).toEqual(['found']);
  });

  it('a script tag inside change_html stays inert, so js is the only execution path', () => {
    document.body.innerHTML = '<div id="hero"></div>';

    applyVariation(7, [
      {
        type: 'change_html',
        selector: '#hero',
        content: '<script>globalThis.__testaProbe.push("inline");</script><p>hi</p>',
      },
    ]);

    expect(globalThis.__testaProbe).toEqual([]);
  });

  it('teardowns from a js change are returned to the caller', () => {
    const teardowns = applyVariation(7, [{ type: 'js', content: probe('ran') }]);
    expect(teardowns.length).toBe(1);
    for (const t of teardowns) t();
    expect(document.querySelector('script[data-testa-js="7"]')).toBeNull();
  });
});
