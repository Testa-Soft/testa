/**
 * DOM variation actions in crobot's shape: hide_element / append_html /
 * prepend_html / move_element_append / move_element_prepend.
 */

import type { VariationChange } from '@testa-platform/shared-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyAppend, applyHide, applyMove, applyPrepend, applyVariation } from '../index.ts';

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

afterEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

// ─── hide_element ────────────────────────────────────────────────────────────

describe('applyHide', () => {
  it('sets display:none on the matching element', () => {
    document.body.innerHTML = '<div class="promo">x</div>';
    applyHide({ type: 'hide_element', selector: '.promo' });
    expect((document.querySelector('.promo') as HTMLElement).style.display).toBe('none');
  });

  it('hides every matching element', () => {
    document.body.innerHTML = '<span class="p">a</span><span class="p">b</span>';
    applyHide({ type: 'hide_element', selector: '.p' });
    const els = document.querySelectorAll<HTMLElement>('.p');
    expect(els[0]?.style.display).toBe('none');
    expect(els[1]?.style.display).toBe('none');
  });

  it('hides elements that render after apply (SPA / late render)', () => {
    const teardown = applyHide({ type: 'hide_element', selector: '.late' });
    const el = document.createElement('div');
    el.className = 'late';
    document.body.appendChild(el);
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(el.style.display).toBe('none');
        teardown();
        resolve();
      }, 0);
    });
  });
});

// ─── append_html ─────────────────────────────────────────────────────────────

describe('applyAppend', () => {
  it('inserts content at the end of the element (beforeend)', () => {
    document.body.innerHTML = '<div class="box"><span class="first">1</span></div>';
    applyAppend({ type: 'append_html', selector: '.box', content: '<span class="added">2</span>' });
    const box = document.querySelector('.box');
    expect(box?.lastElementChild?.classList.contains('added')).toBe(true);
    expect(box?.firstElementChild?.classList.contains('first')).toBe(true);
  });

  it('strips <script> tags defensively', () => {
    document.body.innerHTML = '<div class="box"></div>';
    applyAppend({
      type: 'append_html',
      selector: '.box',
      content: 'a<script>window.__evil = 1</script>b',
    });
    expect(document.querySelector('.box')?.innerHTML).toBe('ab');
    expect((window as unknown as { __evil?: number }).__evil).toBeUndefined();
  });
});

// ─── prepend_html ────────────────────────────────────────────────────────────

describe('applyPrepend', () => {
  it('inserts content at the start of the element (afterbegin)', () => {
    document.body.innerHTML = '<div class="box"><span class="last">1</span></div>';
    applyPrepend({
      type: 'prepend_html',
      selector: '.box',
      content: '<span class="added">0</span>',
    });
    const box = document.querySelector('.box');
    expect(box?.firstElementChild?.classList.contains('added')).toBe(true);
    expect(box?.lastElementChild?.classList.contains('last')).toBe(true);
  });
});

// ─── move_element_* ──────────────────────────────────────────────────────────

describe('applyMove', () => {
  it('relocates the element to the end of the target (move_element_append)', () => {
    document.body.innerHTML =
      '<div id="src"><p class="movable">m</p></div>' +
      '<div id="dst"><span class="pre">p</span></div>';
    applyMove({ type: 'move_element_append', selector: '.movable', content: '#dst' });
    expect(document.querySelector('#src')?.querySelector('.movable')).toBeNull();
    const dst = document.querySelector('#dst');
    expect(dst?.lastElementChild?.classList.contains('movable')).toBe(true);
    expect(dst?.firstElementChild?.classList.contains('pre')).toBe(true);
  });

  it('relocates the element to the start of the target (move_element_prepend)', () => {
    document.body.innerHTML =
      '<div id="src"><p class="movable">m</p></div>' +
      '<div id="dst"><span class="post">p</span></div>';
    applyMove({ type: 'move_element_prepend', selector: '.movable', content: '#dst' });
    const dst = document.querySelector('#dst');
    expect(dst?.firstElementChild?.classList.contains('movable')).toBe(true);
    expect(dst?.lastElementChild?.classList.contains('post')).toBe(true);
  });

  it('is a no-op when the target is missing', () => {
    document.body.innerHTML = '<div id="src"><p class="movable">m</p></div>';
    applyMove({ type: 'move_element_append', selector: '.movable', content: '#nope' });
    expect(document.querySelector('#src')?.querySelector('.movable')).not.toBeNull();
  });

  it('moves every matching element under the target', () => {
    document.body.innerHTML = '<p class="m">a</p><p class="m">b</p><div id="dst"></div>';
    applyMove({ type: 'move_element_append', selector: '.m', content: '#dst' });
    expect(document.querySelectorAll('#dst .m').length).toBe(2);
  });
});

// ─── orchestrator wiring ─────────────────────────────────────────────────────

describe('applyVariation — DOM actions', () => {
  it('dispatches hide / append / prepend / move through the switch', () => {
    document.body.innerHTML =
      '<div class="hideme">x</div>' +
      '<div class="box"></div>' +
      '<p class="mov">m</p><div id="dst"></div>';
    const changes: VariationChange[] = [
      { type: 'hide_element', selector: '.hideme' },
      { type: 'append_html', selector: '.box', content: '<i class="a"></i>' },
      { type: 'prepend_html', selector: '.box', content: '<i class="p"></i>' },
      { type: 'move_element_append', selector: '.mov', content: '#dst' },
    ];
    const teardowns = applyVariation(200, changes);

    expect((document.querySelector('.hideme') as HTMLElement).style.display).toBe('none');
    const box = document.querySelector('.box');
    expect(box?.firstElementChild?.classList.contains('p')).toBe(true);
    expect(box?.lastElementChild?.classList.contains('a')).toBe(true);
    expect(document.querySelector('#dst .mov')).not.toBeNull();
    expect(teardowns.length).toBe(4);
  });
});
