/**
 * The head-time config preload snippet.
 *
 * It runs while the HTML is still parsing, so everything it needs must be
 * computed in the browser: `_document.tsx` renders at BUILD time for statically
 * optimized pages, and anything baked into this string is frozen into every
 * future page load.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONFIG_PROMISE_KEY, buildConfigPreloadSnippet } from '../config-preload.ts';

const URL_A = 'https://cfg.example/api/v1/config/acme';

afterEach(() => {
  delete (window as unknown as Record<string, unknown>)[CONFIG_PROMISE_KEY];
  vi.restoreAllMocks();
});

/** Evaluate the snippet the way a `<head>` script tag would. */
function evaluate(snippet: string): void {
  // biome-ignore lint/security/noGlobalEval: exercising the emitted head snippet
  eval(snippet);
}

describe('buildConfigPreloadSnippet', () => {
  it('starts the fetch and parks the promise on the well-known global', async () => {
    const fetchSpy = vi.fn(async () => new Response('{"slug":"acme"}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    evaluate(buildConfigPreloadSnippet({ url: URL_A }));

    const pending = (window as unknown as Record<string, unknown>)[CONFIG_PROMISE_KEY];
    expect(pending).toBeDefined();
    await expect(pending as Promise<unknown>).resolves.toEqual({ slug: 'acme' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('busts the browser cache with a token built at page-load time', () => {
    const fetchSpy = vi.fn(async (_url: string) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    evaluate(buildConfigPreloadSnippet({ url: URL_A }));

    const requested = fetchSpy.mock.calls[0]?.[0] ?? '';
    expect(requested).toMatch(/^https:\/\/cfg\.example\/api\/v1\/config\/acme\?_testa_t=[a-z0-9]+$/);
  });

  it('appends the token with & when the url already has a query', () => {
    const fetchSpy = vi.fn(async (_url: string) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    evaluate(buildConfigPreloadSnippet({ url: `${URL_A}?env=staging` }));

    expect(fetchSpy.mock.calls[0]?.[0]).toContain('?env=staging&_testa_t=');
  });

  it('never starts a second fetch when one is already parked', () => {
    const fetchSpy = vi.fn(async (_url: string) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    evaluate(buildConfigPreloadSnippet({ url: URL_A }));
    evaluate(buildConfigPreloadSnippet({ url: URL_A }));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('resolves null rather than rejecting when the fetch fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );

    evaluate(buildConfigPreloadSnippet({ url: URL_A }));

    const pending = (window as unknown as Record<string, unknown>)[CONFIG_PROMISE_KEY];
    await expect(pending as Promise<unknown>).resolves.toBeNull();
  });
});
