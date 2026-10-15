/**
 * Session-entry attribution + device / visit fields (task 5.6).
 */
import type { PixelEvent, ProjectConfig } from '@testa-platform/shared-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetPixelState } from '../../__test-utils__/reset.ts';
import { installQueue } from '../../loader/queue.ts';
import { ENTRY_STORAGE_KEY, readUtms, stripClickIds } from '../attribution.ts';
import {
  __clearPendingEventsForTests,
  __getPendingEventsForTests,
  hydrate,
  runExperimentCycle,
  track,
} from '../lifecycle.ts';
import { SESSION_ID_COOKIE, VISIT_NUMBER_COOKIE } from '../session.ts';
import { eraseValue, readValue } from '../storage.ts';

const SECRET_CLICK_ID = 'Cj0KCQjwSECRETvalue123';

function project(): ProjectConfig {
  return {
    project_id: 42,
    slug: 'demo',
    integration_version: '4.0',
    consent_mode: 'aware',
    experiments: [
      {
        experiment_id: 17,
        status: 'active',
        traffic_allocation: 100,
        platform_version: 'v2',
        rules: [{ match_type: 'contains', url_pattern: '/product/' }],
        variations: [{ variation_id: 170, weight: 100, changes: [] }],
        goals: [],
      },
    ],
    published_at: '2026-10-01T00:00:00.000Z',
    config_hash: 'abc',
  };
}

const sent = (): PixelEvent[] =>
  __getPendingEventsForTests()
    .map((e) => e.event)
    .filter((e): e is PixelEvent => e !== undefined);
const named = (n: string) => sent().filter((e) => e.event_name === n);

function navigate(path: string): void {
  history.pushState(null, '', path);
  runExperimentCycle();
}

beforeEach(async () => {
  await resetPixelState();
  history.replaceState(null, '', '/');
  Object.defineProperty(document, 'referrer', { value: '', configurable: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await resetPixelState();
});

describe('session-entry attribution', () => {
  it('landing page with UTMs, exposure on page 3 → experiment_view carries the entry attribution', () => {
    history.replaceState(
      null,
      '',
      `/?utm_source=google&utm_medium=cpc&utm_campaign=autumn&utm_term=merino&utm_content=ad-1&gclid=${SECRET_CLICK_ID}`,
    );
    Object.defineProperty(document, 'referrer', {
      value: 'https://www.google.com/',
      configurable: true,
    });
    window.cfPrefill = { project: project() };
    installQueue();
    hydrate(); // page 1: no experiment_view (rule /product/), session + entry captured

    expect(named('experiment_view')).toEqual([]);
    Object.defineProperty(document, 'referrer', {
      value: 'https://shop.example/',
      configurable: true,
    });
    navigate('/category/shoes');
    navigate('/product/3');

    const view = named('experiment_view')[0];
    expect(view).toMatchObject({
      entry_referrer: 'https://www.google.com/',
      entry_url: `${location.origin}/?utm_source=google&utm_medium=cpc&utm_campaign=autumn&utm_term=merino&utm_content=ad-1`,
      entry_utm_source: 'google',
      entry_utm_medium: 'cpc',
      entry_utm_campaign: 'autumn',
      entry_utm_term: 'merino',
      entry_utm_content: 'ad-1',
      click_id_type: 'gclid',
    });
    // Current-page UTMs are empty on page 3; entry_* are only on experiment_view.
    expect(view?.utm_source).toBeUndefined();
    for (const e of sent().filter((x) => x.event_name !== 'experiment_view')) {
      expect(e.entry_utm_source).toBeUndefined();
      expect(e.click_id_type).toBeUndefined();
    }
  });

  it('the click-id VALUE never appears in any payload', () => {
    history.replaceState(null, '', `/product/1?fbclid=${SECRET_CLICK_ID}&utm_source=fb`);
    window.cfPrefill = { project: project() };
    installQueue();
    hydrate();
    track('add_to_cart', { value_native: 10, currency: 'EUR' });
    const all = JSON.stringify(sent());
    expect(sent().length).toBeGreaterThan(0);
    expect(all).not.toContain(SECRET_CLICK_ID);
    expect(named('experiment_view')[0]?.click_id_type).toBe('fbclid');
    expect(named('page_view')[0]?.url).toBe(`${location.origin}/product/1?utm_source=fb`);
  });

  it('a new browsing session re-captures the entry; blocked sessionStorage never breaks tracking', () => {
    history.replaceState(null, '', '/product/1?utm_source=newsletter&utm_medium=email');
    window.cfPrefill = { project: project() };
    installQueue();
    hydrate();
    expect(sessionStorage.getItem(ENTRY_STORAGE_KEY)).toContain('newsletter');

    __clearPendingEventsForTests();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    eraseValue(SESSION_ID_COOKIE); // new browsing session
    navigate('/product/2?utm_source=bing&utm_medium=cpc');
    const view = named('experiment_view')[0];
    expect(view?.entry_utm_source).toBe('bing');
  });
});

describe('visit_number (_testa_vn) and device fields', () => {
  it('increments once per new browsing session and rides on every event', () => {
    history.replaceState(null, '', '/product/1');
    window.cfPrefill = { project: project() };
    installQueue();
    hydrate();
    track('add_to_cart');
    expect(readValue(VISIT_NUMBER_COOKIE)).toBe('1');
    expect(sent().every((e) => e.visit_number === 1)).toBe(true);

    eraseValue(SESSION_ID_COOKIE);
    track('add_to_cart');
    expect(readValue(VISIT_NUMBER_COOKIE)).toBe('2');
    expect(named('add_to_cart').at(-1)?.visit_number).toBe(2);
  });

  it('screen_w / screen_h on every event', () => {
    history.replaceState(null, '', '/product/1');
    window.cfPrefill = { project: project() };
    installQueue();
    hydrate();
    for (const e of sent()) {
      expect(e.screen_w).toBe(screen.width);
      expect(e.screen_h).toBe(screen.height);
    }
  });
});

describe('helpers', () => {
  it('readUtms reads all five UTMs', () => {
    expect(
      readUtms('?utm_source=a&utm_medium=b&utm_campaign=c&utm_term=d&utm_content=e&x=1'),
    ).toEqual({
      utm_source: 'a',
      utm_medium: 'b',
      utm_campaign: 'c',
      utm_term: 'd',
      utm_content: 'e',
    });
    expect(readUtms('')).toEqual({});
  });

  it('stripClickIds removes every click-id param and nothing else', () => {
    expect(stripClickIds('https://s.example/p?gclid=1&a=2&msclkid=3&li_fat_id=4')).toBe(
      'https://s.example/p?a=2',
    );
    expect(stripClickIds('https://s.example/p?a=2')).toBe('https://s.example/p?a=2');
    expect(stripClickIds('not a url')).toBe('not a url');
  });
});
