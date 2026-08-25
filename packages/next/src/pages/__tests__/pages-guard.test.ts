/**
 * `@testa-soft/next/pages` `<TestaGuard/>` — the `_document.tsx` shield.
 *
 * The contract that matters: it must emit an INLINE script (no src), because
 * only markup evaluated while `<head>` is parsing hides content before the
 * browser paints server-rendered HTML.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TestaGuard } from '../TestaGuard.tsx';

const render = (props = {}) => renderToStaticMarkup(createElement(TestaGuard, props));

describe('pages <TestaGuard/>', () => {
  it('renders an inline script (never an external src)', () => {
    const html = render();
    expect(html).toMatch(/^<script>/);
    expect(html).not.toContain('src=');
  });

  it('shields the body by default', () => {
    expect(render()).toContain('body');
  });

  it('honours a custom selector and timeout', () => {
    const html = render({ selector: '#root', timeoutMs: 1500 });
    expect(html).toContain('#root');
    expect(html).toContain('1500');
  });

  it('always carries a reveal timeout so a failed apply cannot hide the page forever', () => {
    // Default is 4000ms — the snippet must embed it even when unspecified.
    expect(render()).toContain('4000');
  });
});
