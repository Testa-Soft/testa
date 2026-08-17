import { ASSIGNMENT_COOKIE, UUID_COOKIE, markRedirected } from '@testa-soft/experiment-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initTesta } from '../init.ts';
import { domConfig, memoryStore, splitUrlConfig } from './helpers.ts';

const AT_PAGE = 'https://acme.com/pricing';

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('initTesta — visitor id', () => {
  it('mints a _testa_uuid when absent', async () => {
    const store = memoryStore();
    await initTesta({
      config: splitUrlConfig(),
      currentUrl: 'https://acme.com/home',
      store,
      tracking: false,
      navigate: () => undefined,
    });
    expect(store.get(UUID_COOKIE)).toBeTruthy();
  });

  it('keeps an existing visitor id', async () => {
    const store = memoryStore({ [UUID_COOKIE]: 'keep-me' });
    await initTesta({
      config: splitUrlConfig(),
      currentUrl: 'https://acme.com/home',
      store,
      tracking: false,
      navigate: () => undefined,
    });
    expect(store.get(UUID_COOKIE)).toBe('keep-me');
  });
});

describe('initTesta — DOM apply', () => {
  it('applies the assigned variant DOM changes given a cookie', async () => {
    document.body.innerHTML = '<div id="hero">CONTROL</div>';
    const store = memoryStore({ [UUID_COOKIE]: 'v', [ASSIGNMENT_COOKIE]: '101.2.0.0' });
    const res = await initTesta({
      config: domConfig(),
      currentUrl: AT_PAGE,
      store,
      tracking: false,
      navigate: () => undefined,
    });
    expect(res.redirected).toBe(false);
    expect(document.querySelector('#hero')?.innerHTML).toBe('VARIANT');
    expect(res.teardowns.length).toBeGreaterThan(0);
  });
});

describe('initTesta — client redirect', () => {
  it('navigates to the destination and marks the redirect guard', async () => {
    const store = memoryStore({ [UUID_COOKIE]: 'v', [ASSIGNMENT_COOKIE]: '101.2.0.0' });
    const navigate = vi.fn();
    const res = await initTesta({
      config: splitUrlConfig(),
      currentUrl: AT_PAGE,
      store,
      tracking: false,
      navigate,
    });
    expect(navigate).toHaveBeenCalledOnce();
    expect(navigate.mock.calls[0]?.[0]).toContain('/pricing-v2');
    expect(res.redirected).toBe(true);
    // Loop guard written.
    expect(store.get('_testa_redirected_101')).toBe('1');
  });

  it('does NOT re-navigate once the loop guard is set (already bounced)', async () => {
    const store = memoryStore({ [UUID_COOKIE]: 'v', [ASSIGNMENT_COOKIE]: '101.2.0.0' });
    markRedirected(store, 101);
    const navigate = vi.fn();
    const res = await initTesta({
      config: splitUrlConfig(),
      currentUrl: AT_PAGE,
      store,
      tracking: false,
      navigate,
    });
    expect(navigate).not.toHaveBeenCalled();
    expect(res.redirected).toBe(false);
  });
});

describe('initTesta — preview mode', () => {
  it('fetches + applies draft changes, skipping assignment', async () => {
    document.body.innerHTML = '<div id="hero">CONTROL</div>';
    const store = memoryStore({ [UUID_COOKIE]: 'v' });
    const changes = [{ type: 'change_html', selector: '#hero', content: 'DRAFT' }];
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ changes }), { status: 200 })) as unknown as typeof fetch;
    const res = await initTesta({
      config: splitUrlConfig(),
      currentUrl: `${AT_PAGE}?testa_preview=true&testa_preview_token=tok`,
      store,
      previewApiUrl: 'https://app.testa-soft.tech',
      tracking: false,
      navigate: () => undefined,
      fetchImpl,
    });
    expect(res.applied).toHaveLength(0);
    expect(document.querySelector('#hero')?.innerHTML).toBe('DRAFT');
    // No assignment cookie written in preview mode.
    expect(store.get(ASSIGNMENT_COOKIE)).toBeNull();
  });
});

describe('initTesta — exposure tracking', () => {
  it('emits one exposure per fresh enrollment when tracking is on', async () => {
    const store = memoryStore({ [UUID_COOKIE]: 'fresh-visitor' });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('', { status: 200 }));
    await initTesta({
      config: domConfig(),
      currentUrl: AT_PAGE,
      store,
      trackingHost: 'https://track.example.com',
      navigate: () => undefined,
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://track.example.com/api/leads');
  });

  it('does not emit when tracking is off', async () => {
    const store = memoryStore({ [UUID_COOKIE]: 'fresh-visitor' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await initTesta({
      config: domConfig(),
      currentUrl: AT_PAGE,
      store,
      tracking: false,
      navigate: () => undefined,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
