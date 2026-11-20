import { describe, expect, it, vi } from 'vitest';
import { createLegacyTracker } from '../legacy-leads.ts';

function setup(held = false) {
  const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
  let isHeld = held;
  const t = createLegacyTracker({
    host: 'https://crobot.example/',
    isHeld: () => isHeld,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  const calls = () =>
    fetchImpl.mock.calls.map((c) => {
      const [url, init] = c as unknown as [string, RequestInit];
      return { url, body: JSON.parse(String(init.body)) as Record<string, unknown> };
    });
  return {
    t,
    calls,
    release: () => {
      isHeld = false;
    },
  };
}

const exposure = {
  project_id: 2,
  experiment: 14,
  variation: 1,
  uuid: 'u-1',
  url: 'https://s.example/',
};

describe('legacy crobot tracker', () => {
  it('POSTs the 3.3.3 exposure payload once per load', () => {
    const { t, calls } = setup();
    t.exposure(exposure);
    t.exposure(exposure);
    expect(calls()).toEqual([{ url: 'https://crobot.example/api/leads', body: exposure }]);
  });

  it('POSTs conversions with PII-stripped data, deduped per goal + visitor', () => {
    const { t, calls } = setup();
    const conv = {
      goal_id: 9,
      action: 'signup',
      lead_uuid: 'u-1',
      variation: 1,
      data: { plan: 'pro', phone: '1' },
    };
    t.conversion(conv);
    t.conversion(conv);
    expect(calls()).toEqual([
      { url: 'https://crobot.example/api/leads/convert', body: { ...conv, data: { plan: 'pro' } } },
    ]);
  });

  it('sends nothing without a visitor id', () => {
    const { t, calls } = setup();
    t.exposure({ ...exposure, uuid: '' });
    t.conversion({ goal_id: 1, action: 'a', lead_uuid: '', variation: 0, data: {} });
    expect(calls()).toEqual([]);
  });

  it('parks calls while consent is held; replays on grant, drops on deny', () => {
    const a = setup(true);
    a.t.exposure(exposure);
    expect(a.calls()).toEqual([]);
    a.release();
    a.t.onConsent('granted');
    expect(a.calls()).toHaveLength(1);

    const d = setup(true);
    d.t.exposure(exposure);
    d.t.onConsent('denied');
    d.release();
    d.t.onConsent('granted');
    expect(d.calls()).toEqual([]);
  });
});
