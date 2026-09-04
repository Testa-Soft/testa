/**
 * Page-guard + teardown-undo semantics.
 *
 * The appliers watch the DOM (MutationObserver) so React re-renders can't erase
 * a change — but in an SPA the document persists across soft navigations, so an
 * un-guarded watcher happily applies the variant to the NEXT page's matching
 * element (the "/calculator H1 on every page" bug). Two defenses, tested here:
 *
 *   1. `guard()` — checked at the moment a node would be touched (initial sweep
 *      AND observer hits). Guard false → node untouched.
 *   2. Teardown UNDO — `change_html` restores the original innerHTML (only when
 *      our content is still there), `css` removes its style tag, `hide_element`
 *      restores the prior inline display. Covers persistent-layout elements
 *      React never re-mounts and the observer-vs-effect-cleanup race.
 */

import { describe, expect, it } from 'vitest';
import { applyVariation, eachMatching } from '../index.ts';

const tick = () => new Promise((r) => setTimeout(r, 0));

function resetDom(): void {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
}

describe('eachMatching guard', () => {
  it('skips existing matches while the guard is false', () => {
    resetDom();
    document.body.innerHTML = '<h1>original</h1>';
    const stop = eachMatching('h1', (el) => (el.textContent = 'variant'), {
      guard: () => false,
    });
    expect(document.querySelector('h1')?.textContent).toBe('original');
    stop();
  });

  it('skips late-added matches while the guard is false (soft-nav leak)', async () => {
    resetDom();
    document.body.innerHTML = '<h1>calculator</h1>';
    let onExperimentPage = true;
    const stop = eachMatching('h1', (el) => (el.textContent = 'variant'), {
      guard: () => onExperimentPage,
    });
    expect(document.querySelector('h1')?.textContent).toBe('variant');

    // Soft nav: the router swaps the page content in the SAME document.
    onExperimentPage = false;
    document.body.innerHTML = '<h1>about page</h1>';
    await tick(); // let the MutationObserver fire

    expect(document.querySelector('h1')?.textContent).toBe('about page');
    stop();
  });

  it('applies to late matches while the guard stays true', async () => {
    resetDom();
    const stop = eachMatching('h1', (el) => (el.textContent = 'variant'), {
      guard: () => true,
    });
    document.body.innerHTML = '<h1>late</h1>';
    await tick();
    expect(document.querySelector('h1')?.textContent).toBe('variant');
    stop();
  });
});

describe('applyVariation guard threading', () => {
  it('change_html + css + hide are all no-ops when the guard is false', () => {
    resetDom();
    document.body.innerHTML = '<h1>original</h1><div class="x">shown</div>';
    const teardowns = applyVariation(
      7,
      [
        { type: 'change_html', selector: 'h1', content: 'variant' },
        { type: 'css', content: 'h1{color:red}' },
        { type: 'hide_element', selector: '.x' },
      ],
      { guard: () => false },
    );
    expect(document.querySelector('h1')?.textContent).toBe('original');
    expect(document.querySelector('style[data-testa-css]')).toBeNull();
    expect((document.querySelector('.x') as HTMLElement).style.display).not.toBe('none');
    for (const t of teardowns) t();
  });
});

describe('teardown undo', () => {
  it('change_html teardown restores the original innerHTML', () => {
    resetDom();
    document.body.innerHTML = '<h1><em>orig</em></h1>';
    const teardowns = applyVariation(7, [{ type: 'change_html', selector: 'h1', content: 'variant' }]);
    expect(document.querySelector('h1')?.textContent).toBe('variant');
    for (const t of teardowns) t();
    expect(document.querySelector('h1')?.innerHTML).toBe('<em>orig</em>');
  });

  it('change_html teardown does NOT stomp content React re-rendered meanwhile', () => {
    resetDom();
    document.body.innerHTML = '<h1>orig</h1>';
    const teardowns = applyVariation(7, [{ type: 'change_html', selector: 'h1', content: 'variant' }]);
    // React re-rendered the node with fresh content — our change is gone already.
    const h1 = document.querySelector('h1') as HTMLElement;
    h1.innerHTML = 'react-owned';
    for (const t of teardowns) t();
    expect(h1.innerHTML).toBe('react-owned');
  });

  it('css teardown removes the injected style tag', () => {
    resetDom();
    const teardowns = applyVariation(7, [{ type: 'css', content: 'h1{color:red}' }]);
    expect(document.querySelector('style[data-testa-css="7"]')).not.toBeNull();
    for (const t of teardowns) t();
    expect(document.querySelector('style[data-testa-css="7"]')).toBeNull();
  });

  it('hide_element teardown restores the prior inline display', () => {
    resetDom();
    document.body.innerHTML = '<div class="x" style="display:flex">shown</div>';
    const teardowns = applyVariation(7, [{ type: 'hide_element', selector: '.x' }]);
    const el = document.querySelector('.x') as HTMLElement;
    expect(el.style.display).toBe('none');
    for (const t of teardowns) t();
    expect(el.style.display).toBe('flex');
  });

  it('observer race repair: a wrongly-applied late hit is undone by teardown', async () => {
    resetDom();
    document.body.innerHTML = '<h1>calculator</h1>';
    // No guard (worst case): observer applies to the next page's h1 before the
    // effect cleanup runs — teardown must restore it.
    const teardowns = applyVariation(7, [{ type: 'change_html', selector: 'h1', content: 'variant' }]);
    document.body.innerHTML = '<h1>about page</h1>';
    await tick(); // observer wrongly applies to the new h1
    expect(document.querySelector('h1')?.textContent).toBe('variant');
    for (const t of teardowns) t();
    expect(document.querySelector('h1')?.textContent).toBe('about page');
  });
});

describe('change_html keeper (React-clobber re-assert)', () => {
  it('re-asserts the change when the host framework overwrites the content', async () => {
    resetDom();
    document.body.innerHTML = '<h1>Calculator</h1>';
    const teardowns = applyVariation(7, [{ type: 'change_html', selector: 'h1', content: 'variant' }]);
    const h1 = document.querySelector('h1') as HTMLElement;
    expect(h1.textContent).toBe('variant');

    // React reconciliation on a soft nav: same element, textContent rewritten.
    h1.textContent = 'Home';
    await tick();
    expect(h1.textContent).toBe('variant'); // keeper re-asserted

    // The restore target followed the clobber: teardown restores REACT's latest
    // content ('Home'), never the stale pre-apply capture ('Calculator').
    for (const t of teardowns) t();
    expect(h1.textContent).toBe('Home');
  });

  it('does NOT re-assert when the guard has turned false (navigated off-page)', async () => {
    resetDom();
    document.body.innerHTML = '<h1>Calculator</h1>';
    let onPage = true;
    const teardowns = applyVariation(7, [{ type: 'change_html', selector: 'h1', content: 'variant' }], {
      guard: () => onPage,
    });
    const h1 = document.querySelector('h1') as HTMLElement;
    expect(h1.textContent).toBe('variant');

    onPage = false;
    h1.textContent = 'About';
    await tick();
    expect(h1.textContent).toBe('About'); // off-page: React's content stands
    for (const t of teardowns) t();
  });

  it('keeper survives past the 10s new-match window (no timeout on re-assert)', async () => {
    resetDom();
    document.body.innerHTML = '<h1>orig</h1>';
    const teardowns = applyVariation(
      7,
      [{ type: 'change_html', selector: 'h1', content: 'variant' }],
    );
    const h1 = document.querySelector('h1') as HTMLElement;
    // Simulate repeated framework rewrites — each must be re-asserted.
    for (let i = 0; i < 3; i++) {
      h1.textContent = `render-${i}`;
      await tick();
      expect(h1.textContent).toBe('variant');
    }
    for (const t of teardowns) t();
    expect(h1.textContent).toBe('render-2');
  });
});
