/**
 * Two `change_html` changes on the SAME element (two experiments, or two
 * changes of one variation, both targeting the page's `h1`).
 *
 * Each applier's keeper re-asserts its content whenever the element drifts.
 * Before the fix, A's write was drift to B and B's write was drift to A, so the
 * two observers rewrote the element forever — a MutationObserver storm that
 * never yields and locks the tab (found live: a plain `<script>` pixel page
 * never reached `load`). The later write must win and the keepers must settle.
 */

import { describe, expect, it } from 'vitest';
import { applyChangeHtml } from '../html.ts';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('change_html keepers on one element', () => {
  it('settles: the later change wins, no rewrite storm', async () => {
    document.body.innerHTML = '<h1 id="hero">original</h1>';
    const el = document.getElementById('hero') as HTMLElement;
    let writes = 0;
    const counter = new MutationObserver((records) => {
      writes += records.length;
    });
    counter.observe(el, { childList: true, characterData: true, subtree: true });

    const stopA = applyChangeHtml({ type: 'change_html', selector: '#hero', content: 'A text' });
    const stopB = applyChangeHtml({ type: 'change_html', selector: '#hero', content: 'B text' });
    for (let i = 0; i < 20; i++) await tick();

    expect(el.innerHTML).toBe('B text');
    expect(writes).toBeLessThan(10);
    counter.disconnect();
    stopB();
    stopA();
  });

  it('the winning keeper still re-asserts after a framework clobber', async () => {
    document.body.innerHTML = '<h1 id="hero">original</h1>';
    const el = document.getElementById('hero') as HTMLElement;
    const stopA = applyChangeHtml({ type: 'change_html', selector: '#hero', content: 'A text' });
    const stopB = applyChangeHtml({ type: 'change_html', selector: '#hero', content: 'B text' });
    await tick();

    el.textContent = 'framework render';
    for (let i = 0; i < 20; i++) await tick();

    expect(el.innerHTML).toBe('B text');
    stopB();
    stopA();
  });

  it('a lone keeper still re-asserts after a framework clobber', async () => {
    document.body.innerHTML = '<h1 id="hero">original</h1>';
    const el = document.getElementById('hero') as HTMLElement;
    const stop = applyChangeHtml({ type: 'change_html', selector: '#hero', content: 'A text' });
    await tick();
    el.textContent = 'framework render';
    await tick();
    expect(el.innerHTML).toBe('A text');
    stop();
  });
});
