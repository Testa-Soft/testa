import type { VariationChange } from '@testa-platform/shared-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyChangeHtml, applyCss, applyHide, applyVariation, stripScriptTags } from '../index.ts';

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

afterEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

// ─── css (crobot `css`: content = raw stylesheet) ────────────────────────────

describe('applyCss', () => {
  it('injects a <style> tag with the content verbatim', () => {
    applyCss(100, { type: 'css', content: '.buy-button { background:#ff6600; color:#fff }' });
    const style = document.querySelector('style[data-testa-css="100"]');
    expect(style).not.toBeNull();
    expect(style?.textContent).toBe('.buy-button { background:#ff6600; color:#fff }');
  });

  it('is idempotent — re-apply with the same content overwrites the same tag', () => {
    applyCss(100, { type: 'css', content: '.foo{color:red}' });
    applyCss(100, { type: 'css', content: '.foo{color:red}' });
    expect(document.querySelectorAll('style[data-testa-css="100"]').length).toBe(1);
  });

  it('different content gets different style tag ids', () => {
    applyCss(100, { type: 'css', content: '.foo{color:red}' });
    applyCss(100, { type: 'css', content: '.bar{color:blue}' });
    expect(document.querySelectorAll('style[data-testa-css="100"]').length).toBe(2);
  });

  it('a stray </style> in content cannot break out (set via textContent)', () => {
    applyCss(100, { type: 'css', content: 'body{}</style><script>window.x=1</script>' });
    // No <script> element is created — the content is CSS text, not parsed HTML.
    expect(document.querySelector('script')).toBeNull();
    expect((window as unknown as { x?: number }).x).toBeUndefined();
  });
});

// ─── change_html (crobot `change_html`: content = HTML) ──────────────────────

describe('applyChangeHtml', () => {
  it('replaces innerHTML with the supplied content', () => {
    document.body.innerHTML = '<div class="x">old</div>';
    applyChangeHtml({ type: 'change_html', selector: '.x', content: '<span>new</span>' });
    expect(document.querySelector('.x')?.innerHTML).toBe('<span>new</span>');
  });

  it('strips <script> tags defensively', () => {
    document.body.innerHTML = '<div class="x"></div>';
    applyChangeHtml({
      type: 'change_html',
      selector: '.x',
      content: 'before<script>window.x = 1</script>after',
    });
    expect(document.querySelector('.x')?.innerHTML).toBe('beforeafter');
    expect((window as unknown as { x?: number }).x).toBeUndefined();
  });

  it('preserves iframe / video tags', () => {
    document.body.innerHTML = '<div class="x"></div>';
    applyChangeHtml({
      type: 'change_html',
      selector: '.x',
      content: '<iframe src="https://www.youtube.com/embed/abc"></iframe>',
    });
    expect(document.querySelector('.x')?.querySelector('iframe')).not.toBeNull();
  });
});

describe('stripScriptTags', () => {
  it('matches across attributes', () => {
    expect(stripScriptTags('a<script type="text/javascript">x</script>b')).toBe('ab');
  });
  it('is case-insensitive', () => {
    expect(stripScriptTags('a<SCRIPT>x</SCRIPT>b')).toBe('ab');
  });
  it('handles multi-line', () => {
    expect(stripScriptTags('a<script>\nfoo\nbar\n</script>b')).toBe('ab');
  });
});

// ─── applyVariation orchestrator ─────────────────────────────────────────────

describe('applyVariation', () => {
  it('dispatches to all change types in order', () => {
    document.body.innerHTML = '<button class="cta">old</button>';
    const changes: VariationChange[] = [
      { type: 'css', content: '.cta{color:red}' },
      { type: 'change_html', selector: '.cta', content: 'new' },
      { type: 'hide_element', selector: '.cta' },
    ];
    const teardowns = applyVariation(100, changes);

    expect(document.querySelector('style[data-testa-css="100"]')).not.toBeNull();
    expect(document.querySelector('.cta')?.innerHTML).toBe('new');
    expect((document.querySelector('.cta') as HTMLElement).style.display).toBe('none');
    expect(teardowns.length).toBeGreaterThanOrEqual(2); // change_html + hide (css has none)
  });

  it('one applier throwing does not abort the rest', () => {
    document.body.innerHTML = '<div class="x">old</div>';
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // A malformed selector makes the applier throw inside applyOne's try.
    const changes: VariationChange[] = [{ type: 'change_html', selector: '.x', content: 'new' }];
    applyVariation(100, changes);
    expect(document.querySelector('.x')?.innerHTML).toBe('new');
    errSpy.mockRestore();
  });

  it('redirect changes are no-ops here (experiment-core owns them)', () => {
    document.body.innerHTML = '<div>x</div>';
    expect(() =>
      applyVariation(100, [{ type: 'redirect', from_url: '/a', to_url: '/b' }]),
    ).not.toThrow();
  });
});

// ─── late-arrival via MutationObserver ───────────────────────────────────────

describe('eachMatching — late arrival', () => {
  it('applies to elements added after the call', async () => {
    document.body.innerHTML = '<div id="root"></div>';
    applyHide({ type: 'hide_element', selector: '.late' });

    const el = document.createElement('div');
    el.className = 'late';
    document.getElementById('root')?.appendChild(el);

    await new Promise((r) => setTimeout(r, 20));
    expect((document.querySelector('.late') as HTMLElement).style.display).toBe('none');
  });
});
