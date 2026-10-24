/**
 * Client-side routing of links an experiment injected. A plain `<a href>`
 * inside `change_html` / `append_html` / `prepend_html` markup must navigate
 * through the host app's router (no document reload) — and nothing else on the
 * page may be touched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyAppend, applyChangeHtml, applyPrepend } from '../../apply/index.ts';
import { historyNavigate, installLinkRouter } from '../link-router.ts';

const ORIGIN = 'https://shop.example.com';

let uninstall: () => void = () => undefined;
let navigate: ReturnType<typeof vi.fn<(href: string) => void>>;
/** Whether the router cancelled the last click, read before `blockDefault` runs. */
let routed = false;

/**
 * Registered after the router, so it runs last: it records the router's verdict
 * and then cancels the click, because happy-dom otherwise performs the real
 * link navigation (and fetches the URL) for every click left to the browser.
 */
const blockDefault = (event: Event): void => {
  routed = event.defaultPrevented;
  event.preventDefault();
};

beforeEach(() => {
  (window as unknown as { happyDOM: { setURL: (u: string) => void } }).happyDOM.setURL(
    `${ORIGIN}/start`,
  );
  document.body.innerHTML = '<div id="hero"></div><a id="app-link" href="/app">app</a>';
  navigate = vi.fn<(href: string) => void>();
  uninstall = installLinkRouter(navigate);
  window.addEventListener('click', blockDefault);
});

afterEach(() => {
  uninstall();
  window.removeEventListener('click', blockDefault);
  document.body.innerHTML = '';
});

/** Dispatch a click like a browser does and report whether the router took it. */
function click(el: Element, init: MouseEventInit = {}): boolean {
  routed = false;
  el.dispatchEvent(
    new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init }),
  );
  return routed;
}

function injectHero(html: string): void {
  applyChangeHtml({ type: 'change_html', selector: '#hero', content: html });
}

describe('installLinkRouter', () => {
  it('routes a same-origin link injected by change_html through navigate', () => {
    injectHero('<a id="cta" href="/pricing?plan=pro#top">See pricing</a>');
    const prevented = click(document.querySelector('#cta') as Element);
    expect(prevented).toBe(true);
    expect(navigate).toHaveBeenCalledWith('/pricing?plan=pro#top');
  });

  it('routes a click on an element nested inside the injected link', () => {
    injectHero('<div class="card"><a href="/pricing"><span id="label">Go</span></a></div>');
    expect(click(document.querySelector('#label') as Element)).toBe(true);
    expect(navigate).toHaveBeenCalledWith('/pricing');
  });

  it('routes links injected by append_html and prepend_html', () => {
    applyAppend({ type: 'append_html', selector: '#hero', content: '<a id="a" href="/a">a</a>' });
    applyPrepend({ type: 'prepend_html', selector: '#hero', content: '<a id="b" href="/b">b</a>' });
    click(document.querySelector('#a') as Element);
    click(document.querySelector('#b') as Element);
    expect(navigate.mock.calls).toEqual([['/a'], ['/b']]);
  });

  it('routes an injected top-level text+link mix (link is a direct child)', () => {
    injectHero('Ready? <a id="cta" href="/signup">Sign up</a>');
    expect(click(document.querySelector('#cta') as Element)).toBe(true);
    expect(navigate).toHaveBeenCalledWith('/signup');
  });

  it("never touches the host app's own links", () => {
    expect(click(document.querySelector('#app-link') as Element)).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('leaves cross-origin links to the browser', () => {
    injectHero('<a id="ext" href="https://other.example.com/x">x</a>');
    expect(click(document.querySelector('#ext') as Element)).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it.each([
    ['ctrlKey', { ctrlKey: true }],
    ['metaKey', { metaKey: true }],
    ['shiftKey', { shiftKey: true }],
    ['altKey', { altKey: true }],
    ['middle button', { button: 1 }],
  ])('leaves a %s click to the browser (new tab / window / download)', (_, init) => {
    injectHero('<a id="cta" href="/pricing">p</a>');
    expect(click(document.querySelector('#cta') as Element, init)).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it.each([
    ['target=_blank', '<a id="cta" href="/p" target="_blank">p</a>'],
    ['download', '<a id="cta" href="/file.pdf" download>p</a>'],
    ['mailto:', '<a id="cta" href="mailto:a@b.co">p</a>'],
    ['in-page hash on the current page', '<a id="cta" href="#faq">p</a>'],
    ['bare "#" (dismiss / close links)', '<a id="cta" href="#">p</a>'],
    ['empty href', '<a id="cta" href="">p</a>'],
    ['the current page itself', '<a id="cta" href="/start">p</a>'],
  ])('leaves a %s link to the browser', (_, html) => {
    injectHero(html);
    expect(click(document.querySelector('#cta') as Element)).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('routes target=_self like a plain link', () => {
    injectHero('<a id="cta" href="/p" target="_self">p</a>');
    expect(click(document.querySelector('#cta') as Element)).toBe(true);
    expect(navigate).toHaveBeenCalledWith('/p');
  });

  it("defers to a handler that already cancelled the click (e.g. the variation's js)", () => {
    injectHero('<a id="cta" href="/pricing">p</a>');
    const cta = document.querySelector('#cta') as Element;
    cta.addEventListener('click', (e) => e.preventDefault());
    click(cta);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('falls back to a full navigation when navigate throws', () => {
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => undefined);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    navigate.mockImplementation(() => {
      throw new Error('router not ready');
    });
    injectHero('<a id="cta" href="/pricing">p</a>');
    click(document.querySelector('#cta') as Element);
    expect(assign).toHaveBeenCalledWith('/pricing');
    expect(logged).toHaveBeenCalled();
    assign.mockRestore();
    logged.mockRestore();
  });

  it('stops routing after uninstall', () => {
    injectHero('<a id="cta" href="/pricing">p</a>');
    uninstall();
    expect(click(document.querySelector('#cta') as Element)).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('navigates once when two routers are installed (first one wins)', () => {
    const second = vi.fn<(href: string) => void>();
    window.removeEventListener('click', blockDefault);
    const uninstallSecond = installLinkRouter(second);
    window.addEventListener('click', blockDefault);
    injectHero('<a id="cta" href="/pricing">p</a>');
    click(document.querySelector('#cta') as Element);
    expect(navigate.mock.calls.length + second.mock.calls.length).toBe(1);
    uninstallSecond();
  });
});

describe('historyNavigate', () => {
  it('pushes the URL and notifies popstate listeners (React Router, TanStack, …)', () => {
    const onPop = vi.fn();
    window.addEventListener('popstate', onPop);
    historyNavigate('/pricing?x=1');
    window.removeEventListener('popstate', onPop);
    expect(window.location.pathname + window.location.search).toBe('/pricing?x=1');
    expect(onPop).toHaveBeenCalledTimes(1);
  });
});
