/**
 * `legacyCookiesEnabled` through the CLIENT engine.
 *
 * This is the path a cold-start pageview takes — the proxy passed it through
 * without a config, so nothing has adopted the visitor's legacy cookies yet and
 * this engine is the only thing standing between them and a re-bucket. Wiring it
 * here is easy to forget precisely because the middleware tests still pass
 * without it.
 */

import { ASSIGNMENT_COOKIE, UUID_COOKIE } from '@testa-soft/experiment-core';
import { describe, expect, it, vi } from 'vitest';
import { initTesta } from '../init.ts';
import { memoryStore, splitUrlConfig } from './helpers.ts';

const AT_PAGE = 'https://acme.com/pricing';

/** Buckets experiment 101 to the CONTROL variation, so a re-bucket is visible. */
const VISITOR = '00000000-0000-4000-8000-000000000000';

describe('initTesta — legacy cutover', () => {
  it('re-buckets a returning 3.x visitor when the flag is off', async () => {
    const navigate = vi.fn();
    const store = memoryStore({ [UUID_COOKIE]: VISITOR, _testa_exp_101: '2' });

    await initTesta({
      config: splitUrlConfig(),
      currentUrl: AT_PAGE,
      store,
      tracking: false,
      navigate,
    });

    // Legacy said variation 2 (the redirect); invisible here, so they stay on control.
    expect(navigate).not.toHaveBeenCalled();
  });

  it('honours the legacy assignment when the flag is on', async () => {
    const navigate = vi.fn();
    const store = memoryStore({ [UUID_COOKIE]: VISITOR, _testa_exp_101: '2' });

    await initTesta({
      config: splitUrlConfig(),
      currentUrl: AT_PAGE,
      store,
      tracking: false,
      navigate,
      legacyCookiesEnabled: true,
    });

    expect(navigate).toHaveBeenCalledWith(expect.stringContaining('/pricing-v2'));
    expect(store.get(ASSIGNMENT_COOKIE)).toContain('101.2.0.');
  });

  it('migrates on a cookie-first cycle too, where nothing is being decided', async () => {
    // A soft-nav cycle (`allowAssign: false`) never buckets — but it still has
    // to APPLY what the visitor is already on, which means the legacy state has
    // to have been adopted before it reads the packed cookie.
    const store = memoryStore({ [UUID_COOKIE]: VISITOR, _testa_exp_101: '2' });

    await initTesta({
      config: splitUrlConfig(),
      currentUrl: AT_PAGE,
      store,
      tracking: false,
      navigate: () => undefined,
      allowRedirect: false,
      allowAssign: false,
      legacyCookiesEnabled: true,
    });

    expect(store.get(ASSIGNMENT_COOKIE)).toContain('101.2.0.');
  });

  it('changes nothing for a visitor with no legacy cookies', async () => {
    // Not "writes no cookie" — the ENGINE writes its own first-touch targeting
    // cache here regardless. What has to hold is that the flag contributes
    // nothing of its own, so both settings land on the same state.
    const run = async (legacyCookiesEnabled: boolean) => {
      const store = memoryStore({ [UUID_COOKIE]: VISITOR });
      await initTesta({
        config: splitUrlConfig(),
        currentUrl: AT_PAGE,
        store,
        tracking: false,
        navigate: () => undefined,
        now: 1_760_000_000_000,
        legacyCookiesEnabled,
      });
      return store.get(ASSIGNMENT_COOKIE);
    };

    expect(await run(true)).toBe(await run(false));
  });
});
