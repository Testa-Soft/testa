/**
 * A `js` change ships alongside the markup it drives, so it necessarily mutates
 * the DOM inside a `change_html` target. These pin down that the keeper (which
 * exists to undo framework clobbering) tolerates those mutations instead of
 * reverting them.
 */

import type { VariationChange } from '@testa-platform/shared-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyChangeHtml, applyVariation } from '../index.ts';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const teardowns: Array<() => void> = [];

beforeEach(() => {
  document.body.innerHTML = '<div id="hero"></div>';
});

afterEach(() => {
  for (const teardown of teardowns.splice(0)) teardown();
  document.body.innerHTML = '';
  document.head.innerHTML = '';
});

describe('change_html keeper vs variation JS', () => {
  it('leaves a text edit made inside the injected markup alone', async () => {
    teardowns.push(
      applyChangeHtml({
        type: 'change_html',
        selector: '#hero',
        content: '<div class="t-root"><b data-count>0</b></div>',
      }),
    );
    await flush();

    const counter = document.querySelector('[data-count]') as HTMLElement;
    counter.textContent = '4812';
    await flush();

    expect(document.querySelector('[data-count]')?.textContent).toBe('4812');
  });

  it('leaves an attribute/class toggle inside the injected markup alone', async () => {
    teardowns.push(
      applyChangeHtml({
        type: 'change_html',
        selector: '#hero',
        content: '<div class="t-root"><span class="word">a</span></div>',
      }),
    );
    await flush();

    const word = document.querySelector('.word') as HTMLElement;
    word.classList.add('is-active');
    await flush();

    expect(document.querySelector('.word')?.classList.contains('is-active')).toBe(true);
  });

  it('still re-asserts when the framework wipes the injected markup', async () => {
    const content = '<div class="t-root"><b data-count>0</b></div>';
    teardowns.push(applyChangeHtml({ type: 'change_html', selector: '#hero', content }));
    await flush();

    // What React does: rewrite the element's children with its own render.
    (document.querySelector('#hero') as HTMLElement).innerHTML = '<p>react content</p>';
    await flush();

    expect(document.querySelector('.t-root')).not.toBeNull();
  });

  it('a variation that injects markup and then drives it from js settles', async () => {
    const changes: VariationChange[] = [
      {
        type: 'change_html',
        selector: '#hero',
        content: '<div class="t-root"><b data-count>0</b></div>',
      },
      {
        type: 'js',
        content:
          "var el = document.querySelector('[data-count]'); if (el) { el.textContent = '1'; el.textContent = '2'; el.setAttribute('data-done','1'); }",
      },
    ];

    teardowns.push(...applyVariation(9, changes));
    await flush();

    const counter = document.querySelector('[data-count]');
    expect(counter?.textContent).toBe('2');
    expect(counter?.getAttribute('data-done')).toBe('1');
  });
});
