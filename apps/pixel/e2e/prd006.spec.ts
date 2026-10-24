/**
 * PRD-006 validation flow V9 (docs/prds/006-validation.md): the pixel in a real
 * browser with `/track` intercepted. Every title contains "prd006" so the
 * harness runs `pnpm --filter @testa-platform/pixel test:e2e -g prd006`.
 *
 * The loader + runtime are bundled from `src/` with esbuild (in memory) and
 * served for `/__testa/*.js`; the fixture page `fixtures/prd006/index.html`
 * loads them and the project config arrives as `window.cfPrefill` via an init
 * script. Time is faked with `page.clock` (paused, advanced explicitly).
 *
 * Expectations follow the PRD (§1.3, §1.4, §1.7, §1.8, §5.3), not the current
 * code: never weaken them to make a run green.
 */

import { fileURLToPath } from 'node:url';
import { type Page, expect, test } from '@playwright/test';
import type { ExperimentConfig, ProjectConfig } from '@testa-platform/shared-types';
import { build } from 'esbuild';

type Ev = Record<string, unknown> & { event_name: string };
type ExpTuple = [number, number, number, number];

const ORIGIN = 'http://localhost:5173';
const FIXTURE = '/prd006/index.html';
/** §1.7 examples use session_start 1760433600; the clock starts (paused) there. */
const T0_SEC = 1_760_433_600;
const MIN = 60_000;
const POLL_TIMEOUT_MS = 20_000;

// ─── bundle (built once per worker) ─────────────────────────────────────────

let bundles: Promise<{ loader: string; runtime: string }> | null = null;

async function bundle(entry: string, globalName: string): Promise<string> {
  const out = await build({
    entryPoints: [fileURLToPath(new URL(`../src/${entry}`, import.meta.url))],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2017'],
    globalName,
    write: false,
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
  });
  const file = out.outputFiles[0];
  if (!file) throw new Error(`esbuild produced no output for ${entry}`);
  return file.text;
}

function getBundles(): Promise<{ loader: string; runtime: string }> {
  bundles ??= Promise.all([
    bundle('loader.ts', '_testaLoader'),
    bundle('runtime/index.ts', '_testaRuntime'),
  ]).then(([loader, runtime]) => ({ loader, runtime }));
  return bundles;
}

// ─── config builders ────────────────────────────────────────────────────────

function experiment(id: number, overrides: Partial<ExperimentConfig> = {}): ExperimentConfig {
  const variationId = id === 1717 ? 101 : id * 10;
  return {
    experiment_id: id,
    status: 'active',
    platform_version: 'v2',
    rules: [{ match_type: 'contains', url_pattern: '/prd006/' }],
    variations: [{ variation_id: variationId, weight: 100, changes: [] }],
    goals: [],
    traffic_allocation: 100,
    ...overrides,
  };
}

/** Absent `platform_version` = v1 (shared-types ExperimentConfig). */
function withoutPlatformVersion(e: ExperimentConfig): ExperimentConfig {
  const { platform_version: _absentMeansV1, ...rest } = e;
  return rest;
}

function project(experiments: ExperimentConfig[]): ProjectConfig {
  return {
    project_id: 900_006,
    slug: 'prd006-v9',
    integration_version: '4.0',
    consent_mode: 'aware',
    experiments,
    published_at: '2026-10-01T00:00:00.000Z',
    config_hash: 'prd006v9',
  };
}

// ─── harness ────────────────────────────────────────────────────────────────

interface Harness {
  events: Ev[];
  bodies: string[];
  /** Advance the clock until an event matching `pred` was POSTed; returns it. */
  waitFor(pred: (e: Ev) => boolean, what: string): Promise<Ev>;
  /** Give the transport several flush windows, for asserting absence. */
  settle(): Promise<void>;
  /** Call `window._testa[method](...args)`; fails clearly when it's missing. */
  call(method: string, ...args: unknown[]): Promise<void>;
}

interface SetupOptions {
  experiments: ExperimentConfig[];
  /** Pre-existing `_testa_exp` cookie value. */
  expCookie?: string;
}

async function setup(page: Page, opts: SetupOptions): Promise<Harness> {
  const { loader, runtime } = await getBundles();
  const events: Ev[] = [];
  const bodies: string[] = [];

  await page.route('**/__testa/*.js', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: route.request().url().endsWith('loader.js') ? loader : runtime,
    }),
  );
  await page.route('**/track', async (route) => {
    const body = route.request().postData() ?? '';
    bodies.push(body);
    const parsed: unknown = JSON.parse(body || '[]');
    for (const e of Array.isArray(parsed) ? parsed : [parsed]) {
      if (e && typeof e === 'object' && typeof (e as Ev).event_name === 'string') {
        events.push(e as Ev);
      }
    }
    await route.fulfill({ status: 204 });
  });

  const cookies = [{ name: '_testa_uuid', value: 'prd006-v9-visitor', url: ORIGIN }];
  if (opts.expCookie !== undefined) {
    cookies.push({ name: '_testa_exp', value: opts.expCookie, url: ORIGIN });
  }
  await page.context().addCookies(cookies);
  await page.addInitScript(
    (prefill) => {
      (window as unknown as { cfPrefill: unknown }).cfPrefill = prefill;
    },
    { project: project(opts.experiments), apiUrl: ORIGIN },
  );

  await page.clock.install({ time: (T0_SEC - 60) * 1000 });
  await page.clock.pauseAt(T0_SEC * 1000);

  const tick = async (): Promise<void> => {
    await page.clock.runFor(600);
    await page.waitForTimeout(50);
  };

  return {
    events,
    bodies,
    async waitFor(pred, what) {
      await expect
        .poll(
          async () => {
            await tick();
            return events.some(pred);
          },
          { message: `expected a /track payload with ${what}`, timeout: POLL_TIMEOUT_MS },
        )
        .toBe(true);
      const found = events.find(pred);
      if (!found) throw new Error(`lost ${what}`);
      return found;
    },
    async settle() {
      for (let i = 0; i < 6; i += 1) await tick();
    },
    async call(method, ...args) {
      await page.evaluate(
        ([m, a]) => {
          const api = (window as unknown as { _testa?: Record<string, unknown> })._testa;
          const fn = api?.[m];
          if (typeof fn !== 'function') throw new Error(`window._testa.${m} missing`);
          (fn as (...xs: unknown[]) => void).apply(api, a);
        },
        [method, args] as const,
      );
    },
  };
}

const named =
  (name: string) =>
  (e: Ev): boolean =>
    e.event_name === name;

function expOf(e: Ev): ExpTuple[] {
  const exp = e.exp;
  if (!Array.isArray(exp)) throw new Error(`${e.event_name} has no exp array`);
  return exp as ExpTuple[];
}

function tupleFor(e: Ev, experimentId: number): ExpTuple {
  const t = expOf(e).find((x) => x[0] === experimentId);
  if (!t)
    throw new Error(
      `${e.event_name}.exp has no tuple for ${experimentId}: ${JSON.stringify(e.exp)}`,
    );
  return t;
}

/** Load the fixture and wait for the 1717 exposure; `exp` is asserted by each test. */
async function openAndExpose(page: Page, h: Harness): Promise<Ev> {
  await page.goto(FIXTURE);
  return h.waitFor(named('experiment_view'), 'experiment_view');
}

// ─── sessions (§1.3, §5.3) ──────────────────────────────────────────────────

test.describe('prd006 V9 experiment sessions', () => {
  test('prd006 59 min idle keeps the same sessionStart', async ({ page }) => {
    const h = await setup(page, { experiments: [experiment(1717)] });
    const view = await openAndExpose(page, h);
    expect.soft(view.exp, 'experiment_view.exp').toEqual([[1717, 101, T0_SEC, 1]]);

    await page.clock.fastForward(59 * MIN);
    await h.call('track', 'idle_59');
    const ev = await h.waitFor(named('idle_59'), 'idle_59');
    expect(ev.exp, 'idle_59.exp').toEqual([[1717, 101, T0_SEC, 1]]);
  });

  test('prd006 61 min idle drops events and counts dropped_no_session', async ({ page }) => {
    const h = await setup(page, { experiments: [experiment(1717)] });
    await openAndExpose(page, h);

    await page.clock.fastForward(61 * MIN);
    await h.call('track', 'idle_61_a');
    await h.call('track', 'idle_61_b');
    await h.settle();
    expect(h.events.filter((e) => e.event_name.startsWith('idle_61'))).toEqual([]);

    // Surface the health snapshot: hourly tick + pagehide flush.
    await page.clock.fastForward(60 * MIN);
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    const health = await h.waitFor(
      (e) => e.event_name === '_pixel_health' && typeof e.props === 'object' && e.props !== null,
      '_pixel_health with props',
    );
    const props = health.props as Record<string, unknown>;
    expect(Number(props.dropped_no_session)).toBeGreaterThanOrEqual(2);
  });

  test('prd006 reload after expiry re-fires experiment_view with same variation, sessionIdx 2', async ({
    page,
  }) => {
    const h = await setup(page, { experiments: [experiment(1717)] });
    const first = await openAndExpose(page, h);
    expect.soft(first.exp, 'first experiment_view.exp').toEqual([[1717, 101, T0_SEC, 1]]);

    await page.clock.fastForward(61 * MIN);
    const before = h.events.length;
    await page.reload();
    const view = await h.waitFor(
      (e) => e.event_name === 'experiment_view' && h.events.indexOf(e) >= before,
      'experiment_view after reload',
    );
    const [id, variation, sessionStart, sessionIdx] = tupleFor(view, 1717);
    expect([id, variation, sessionIdx]).toEqual([1717, first.variation_id, 2]);
    expect(sessionStart).toBeGreaterThanOrEqual(T0_SEC + 61 * 60);
  });

  test('prd006 70 min of activity every 5 min is never dropped', async ({ page }) => {
    const h = await setup(page, { experiments: [experiment(1717)] });
    await openAndExpose(page, h);

    for (let i = 1; i <= 14; i += 1) {
      await page.clock.fastForward(5 * MIN);
      await h.call('track', `active_${i}`);
      const ev = await h.waitFor(named(`active_${i}`), `active_${i} at ${i * 5} min`);
      expect.soft(ev.exp, `active_${i}.exp`).toEqual([[1717, 101, T0_SEC, 1]]);
    }
  });

  test('prd006 exp lists only active v2 experiments', async ({ page }) => {
    const h = await setup(page, {
      experiments: [
        experiment(1717),
        experiment(1900, { platform_version: 'v1' }),
        withoutPlatformVersion(experiment(1901)),
        experiment(1902, { traffic_allocation: 0 }),
      ],
    });
    await openAndExpose(page, h);
    await h.call('track', 'probe');
    await h.waitFor(named('probe'), 'probe');

    const stamped = h.events.filter((e) => e.event_name !== '_pixel_health');
    expect(stamped.length).toBeGreaterThan(0);
    for (const e of stamped) {
      expect(
        expOf(e).map((t) => t[0]),
        `${e.event_name}.exp`,
      ).toEqual([1717]);
    }
  });
});

// ─── entry attribution (§1.4, §5.3) ─────────────────────────────────────────

test.describe('prd006 V9 entry attribution', () => {
  test('prd006 entry UTMs from page 1 are on the page-3 experiment_view', async ({ page }) => {
    const onPage3: Partial<ExperimentConfig> = {
      rules: [{ match_type: 'contains', url_pattern: 'step=3' }],
      audience: { fact: 'page.queryParam', op: 'equals', key: 'step', value: '3' },
    };
    const h = await setup(page, { experiments: [experiment(1717, onPage3)] });
    const utms =
      'utm_source=newsletter&utm_medium=email&utm_campaign=autumn_sale&utm_term=merino&utm_content=hero';
    await page.goto(`${FIXTURE}?step=1&${utms}`);
    await h.settle();
    await page.goto(`${FIXTURE}?step=2`);
    await h.settle();
    await page.goto(`${FIXTURE}?step=3`);

    const view = await h.waitFor(
      (e) => e.event_name === 'experiment_view' && String(e.url).includes('step=3'),
      'experiment_view on page 3',
    );
    expect(view).toMatchObject({
      entry_utm_source: 'newsletter',
      entry_utm_medium: 'email',
      entry_utm_campaign: 'autumn_sale',
      entry_utm_term: 'merino',
      entry_utm_content: 'hero',
    });
    expect(String(view.entry_url)).toContain('step=1');
  });

  test('prd006 click-id value is never in the payload', async ({ page }) => {
    const secret = 'CLICKVALUE7f3a9b2c';
    const h = await setup(page, { experiments: [experiment(1717)] });
    await page.goto(`${FIXTURE}?gclid=${secret}`);
    const view = await h.waitFor(named('experiment_view'), 'experiment_view');
    expect(view.click_id_type).toBe('gclid');
    await h.call('track', 'after_click');
    await h.waitFor(named('after_click'), 'after_click');
    for (const body of h.bodies) expect(body).not.toContain(secret);
  });
});

// ─── track* helpers vs §1.7 (one test per helper) ───────────────────────────

const SWEATER = {
  item_id: 'SW-MER-NVY-M',
  product_id: 'SW-MER',
  item_name: 'Merino Crew Sweater',
  item_category: 'Apparel',
  price: 89,
  quantity: 2,
};
const ORDER_ITEMS = [
  { item_id: 'SW-MER-NVY-M', product_id: 'SW-MER', price: 89, quantity: 2 },
  { item_id: 'SCF-WL-GRY', product_id: 'SCF-WL', price: 49, quantity: 1 },
];
const SOCKS = [{ item_id: 'SOCK-WL-3P', product_id: 'SOCK-WL', price: 24, quantity: 1 }];
const EXP_1717: ExpTuple = [1717, 101, T0_SEC, 1];

interface HelperCase {
  title: string;
  method: string;
  args: unknown[];
  event: string;
  expected: Record<string, unknown>;
  /** §1.5: items_count is derived by the edge when omitted; if sent, it must be right. */
  itemsCount?: number;
  /** Seed 1802 with a live 6-field session (the purchase example has 2 tuples). */
  with1802?: boolean;
}

const HELPER_CASES: HelperCase[] = [
  {
    title: 'track add_to_cart with items',
    method: 'track',
    args: ['add_to_cart', { value_native: 178, currency: 'EUR', items: [SWEATER] }],
    event: 'add_to_cart',
    expected: { value_native: 178, currency: 'EUR', items: [SWEATER] },
  },
  {
    title: 'trackAddToCart',
    method: 'trackAddToCart',
    args: [[SWEATER], { currency: 'EUR', cart_id: 'c_8f2a' }],
    event: 'add_to_cart',
    expected: { value_native: 178, currency: 'EUR', cart_id: 'c_8f2a', items: [SWEATER] },
  },
  {
    title: 'trackBeginCheckout',
    method: 'trackBeginCheckout',
    args: [ORDER_ITEMS, { currency: 'EUR', cart_id: 'c_8f2a' }],
    event: 'begin_checkout',
    expected: { value_native: 227, currency: 'EUR', cart_id: 'c_8f2a', items: ORDER_ITEMS },
    itemsCount: 3,
  },
  {
    title: 'trackShippingInfo',
    method: 'trackShippingInfo',
    args: [{ cart_id: 'c_8f2a' }],
    event: 'add_shipping_info',
    expected: { cart_id: 'c_8f2a' },
  },
  {
    title: 'trackPaymentInfo',
    method: 'trackPaymentInfo',
    args: [{ payment_type: 'apple_pay', cart_id: 'c_8f2a', value: 227, currency: 'EUR' }],
    event: 'add_payment_info',
    expected: {
      cart_id: 'c_8f2a',
      value_native: 227,
      currency: 'EUR',
      props: { payment_type: 'apple_pay' },
    },
  },
  {
    title: 'trackPurchase initial (object form)',
    method: 'trackPurchase',
    args: [
      {
        order_id: 'ORD-20261014-0042',
        value: 211.2,
        currency: 'EUR',
        items: ORDER_ITEMS,
        purchase_type: 'initial',
        tax: 37.5,
        shipping: 4.9,
        coupon: 'AUTUMN10',
      },
    ],
    event: 'purchase',
    expected: {
      purchase_type: 'initial',
      order_id: 'ORD-20261014-0042',
      value_native: 211.2,
      currency: 'EUR',
      items: ORDER_ITEMS,
      props: expect.objectContaining({ coupon: 'AUTUMN10' }),
    },
    itemsCount: 3,
    with1802: true,
  },
  {
    title: 'trackPurchase upsell',
    method: 'trackPurchase',
    args: [
      {
        order_id: 'ORD-20261014-0042-U1',
        parent_order_id: 'ORD-20261014-0042',
        purchase_type: 'upsell',
        value: 24,
        currency: 'EUR',
        items: SOCKS,
      },
    ],
    event: 'purchase',
    expected: {
      purchase_type: 'upsell',
      order_id: 'ORD-20261014-0042-U1',
      parent_order_id: 'ORD-20261014-0042',
      value_native: 24,
      currency: 'EUR',
      items: SOCKS,
    },
    itemsCount: 1,
  },
  {
    title: 'trackPurchase positional (compat)',
    method: 'trackPurchase',
    args: [99.95, 'EUR', 'order-7', 3],
    event: 'purchase',
    expected: { value_native: 99.95, currency: 'EUR', order_id: 'order-7', items_count: 3 },
  },
  {
    title: 'trackLead',
    method: 'trackLead',
    args: [{ lead_type: 'quote', form_id: 'b2b_quote' }],
    event: 'generate_lead',
    expected: { props: { lead_type: 'quote', form_id: 'b2b_quote' } },
  },
  {
    title: 'trackSignUp',
    method: 'trackSignUp',
    args: [{ method: 'email' }],
    event: 'sign_up',
    expected: { props: { method: 'email' } },
  },
];

test.describe('prd006 V9 track helpers match PRD §1.7', () => {
  for (const c of HELPER_CASES) {
    test(`prd006 ${c.title} payload`, async ({ page }) => {
      const experiments = [experiment(1717)];
      if (c.with1802) {
        experiments.push(
          experiment(1802, { variations: [{ variation_id: 200, weight: 100, changes: [] }] }),
        );
      }
      const h = await setup(page, {
        experiments,
        ...(c.with1802 ? { expCookie: `1802.200.0.${T0_SEC + 1800}.${T0_SEC - 1800}.3` } : {}),
      });
      await openAndExpose(page, h);
      await h.call(c.method, ...c.args);
      const ev = await h.waitFor(named(c.event), c.event);

      expect(ev).toMatchObject({ event_name: c.event, ...c.expected });
      const wantExp = c.with1802 ? [EXP_1717, [1802, 200, T0_SEC - 1800, 3]] : [EXP_1717];
      const sorted = Array.isArray(ev.exp)
        ? [...(ev.exp as ExpTuple[])].sort((x, y) => x[0] - y[0])
        : ev.exp;
      expect.soft(sorted, `${c.event}.exp`).toEqual(wantExp);
      if (c.title.startsWith('trackPurchase initial')) {
        const props = ev.props as Record<string, unknown>;
        expect([Number(props.tax), Number(props.shipping)]).toEqual([37.5, 4.9]);
      }
      if (c.itemsCount !== undefined && ev.items_count !== undefined) {
        expect(ev.items_count).toBe(c.itemsCount);
      }
    });
  }
});

// ─── legacy packed cookies (§1.3) ───────────────────────────────────────────

test.describe('prd006 V9 old _testa_exp cookies', () => {
  // Variation 101 has weight 0: only the cookie can put the visitor there.
  const twoArms = experiment(1717, {
    variations: [
      { variation_id: 100, weight: 100, changes: [] },
      { variation_id: 101, weight: 0, changes: [] },
    ],
  });

  test('prd006 4-field cookie keeps the variation and starts session 1', async ({ page }) => {
    const h = await setup(page, {
      experiments: [twoArms],
      expCookie: `1717.101.0.${T0_SEC + 1800}`,
    });
    const view = await openAndExpose(page, h);
    expect(view.variation_id, 'variation kept from the 4-field cookie').toBe(101);
    expect(view.exp, 'experiment_view.exp').toEqual([[1717, 101, T0_SEC, 1]]);
  });

  test('prd006 5-field cookie with a live session keeps sessionStart, sessionIdx 1', async ({
    page,
  }) => {
    const start = T0_SEC - 600;
    const h = await setup(page, {
      experiments: [twoArms],
      expCookie: `1717.101.0.${T0_SEC + 1800}.${start}`,
    });
    await page.goto(FIXTURE);
    await h.call('track', 'legacy5');
    const ev = await h.waitFor(named('legacy5'), 'legacy5');
    expect(expOf(ev)).toEqual([[1717, 101, start, 1]]);
  });
});
