// @vitest-environment happy-dom
/**
 * GDPR: personal data never leaves the browser — not in the event URL, the
 * referrer, the props or an exposure — and every event states the consent the
 * customer reported.
 */
import type { PixelEvent, ProjectConfig } from '@testa-platform/shared-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetConsentForTests, setConsent } from '../consent.ts';
import { DocumentCookieStore, __resetMemoryTier } from '../cookie-store.ts';
import { __resetTrackingForTests, startPrd006Tracking, track } from '../track.ts';
import { emitExposure, resetExposureGuard, scrubExposure } from '../tracking.ts';

const config: ProjectConfig = {
  project_id: 42,
  slug: 'demo',
  integration_version: '4.0',
  consent_mode: 'aware',
  experiments: [
    {
      experiment_id: 7,
      status: 'active',
      traffic_allocation: 100,
      rules: [],
      variations: [{ variation_id: 1, weight: 100, changes: [] }],
      goals: [],
      platform_version: 'v2',
    },
  ],
  published_at: '',
  config_hash: 'h',
};

let sent: PixelEvent[] = [];
let stop: () => void = () => undefined;

beforeEach(() => {
  sent = [];
  __resetMemoryTier();
  __resetConsentForTests();
  __resetTrackingForTests();
  window.history.replaceState(null, '', '/thanks?order=9&email=jane%40example.com');
  stop = startPrd006Tracking({
    config,
    store: new DocumentCookieStore({ secure: false, mirrorToStorage: false }),
    send: (events) => sent.push(...events),
  });
});

afterEach(() => {
  stop();
  vi.restoreAllMocks();
});

describe('track', () => {
  it('strips PII from the URL and props, keeping the rest of the event', () => {
    track('page_view', { email: 'jane@example.com', note: 'x jane@example.com', plan: 'pro' });
    const ev = sent[0] as PixelEvent & { props?: Record<string, unknown> };
    expect(ev.url).toMatch(/\/thanks\?order=9$/);
    expect(ev.props).toEqual({ plan: 'pro' });
  });

  it('reports the consent the customer set (unknown by default)', () => {
    track('page_view');
    setConsent('granted');
    track('page_view');
    expect(sent.map((e) => e.consent_state)).toEqual(['unknown', 'granted']);
  });
});

describe('exposures', () => {
  it('scrubs the page URL and title', () => {
    expect(
      scrubExposure({
        project_id: 1,
        experiment: 0,
        variation: 1,
        uuid: 'u',
        url: 'https://a.test/?email=j%40e.com&x=1',
        title: 'Hi jane@example.com',
      }),
    ).toMatchObject({ url: 'https://a.test/?x=1', title: 'Hi [redacted]' });
  });

  it('sends the scrubbed payload', async () => {
    resetExposureGuard();
    const fetchSpy = vi.fn(() => Promise.resolve(new Response(null)));
    vi.stubGlobal('fetch', fetchSpy);
    await emitExposure('https://t.test', {
      project_id: 1,
      experiment: 0,
      variation: 1,
      uuid: 'u',
      url: 'https://a.test/?phone=123',
    });
    const body = JSON.parse(
      (fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    );
    expect(body.url).toBe('https://a.test/');
    vi.unstubAllGlobals();
  });
});
