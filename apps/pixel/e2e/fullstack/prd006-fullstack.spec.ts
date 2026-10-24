/**
 * PRD-006 full stack (tasks 5.5–5.7): the real pixel on a page → real edge
 * (`wrangler dev`) → collector → Redis → consumer → ClickHouse `prd006_p1`.
 * Asserts the STORED rows: exp tuples, entry attribution, edge enrichment,
 * items / event_items, exposures, and that a click-id value never lands.
 */
import { type Page, expect, test } from '@playwright/test';
import { EDGE_PORT, chQuery } from './stack.ts';

const PAGE = '/e2e/fixtures/prd006-fullstack.html';
const SECRET = 'Cj0KCQjwFULLSTACKsecret';

function ids() {
  return {
    projectId: 410_000_000 + Math.floor(Math.random() * 9_000_000),
    experimentId: 510_000_000 + Math.floor(Math.random() * 9_000_000),
  };
}

function project(projectId: number, experimentId: number, version?: 'v2') {
  return {
    project_id: projectId,
    slug: 'fullstack',
    integration_version: '4.0',
    consent_mode: 'aware',
    published_at: '',
    config_hash: String(experimentId),
    experiments: [
      {
        experiment_id: experimentId,
        status: 'active',
        traffic_allocation: 100,
        ...(version ? { platform_version: version } : {}),
        rules: [{ match_type: 'contains', url_pattern: 'page=product' }],
        variations: [
          { variation_id: 100, weight: 50, changes: [] },
          { variation_id: 101, weight: 50, changes: [] },
        ],
        goals: [],
      },
    ],
  };
}

async function boot(page: Page, cfg: unknown, query: string): Promise<void> {
  await page.addInitScript(
    ([c, api]) => {
      (window as unknown as { cfPrefill: unknown }).cfPrefill = { project: c, apiUrl: api };
    },
    [cfg, `http://127.0.0.1:${EDGE_PORT}`] as const,
  );
  await page.goto(`${PAGE}${query}`);
  await page.waitForFunction(
    () => (window as unknown as { _testa?: { _hydrated?: boolean } })._testa?._hydrated === true,
  );
}

/**
 * Wait until the pixel's queued events went out (a POST /track answered) and
 * the debounce settled. The page and the edge are on different ports here, so
 * leaving the page early would fall back to a cross-origin JSON sendBeacon,
 * which browsers refuse (production posts same-origin `/track`).
 */
async function flushed(page: Page): Promise<void> {
  await page.waitForResponse((r) => r.url().endsWith('/track') && r.request().method() === 'POST', {
    timeout: 15_000,
  });
  await page.waitForTimeout(1_500);
}

/** Poll ClickHouse until `sql` returns a row with n >= want. */
async function waitForRows(sql: string, want: number, ms = 60_000): Promise<void> {
  const until = Date.now() + ms;
  for (;;) {
    const [row] = await chQuery<{ n: string }>(sql);
    if (Number(row?.n ?? 0) >= want) return;
    if (Date.now() > until) throw new Error(`timed out waiting for ${want} rows: ${sql}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

test('v2 journey: landing UTMs → product page → helpers, stored with exp + entry attribution', async ({
  page,
}) => {
  const { projectId, experimentId } = ids();
  const cfg = project(projectId, experimentId, 'v2');

  // Page 1: landing with UTMs + a click id (experiment rule does not match here).
  await boot(page, cfg, `?utm_source=google&utm_medium=cpc&utm_campaign=autumn&gclid=${SECRET}`);
  await flushed(page);
  // Page 2: the product page — exposure + commerce events.
  await page.goto(`${PAGE}?page=product`);
  await page.waitForFunction(
    () => (window as unknown as { _testa?: { _hydrated?: boolean } })._testa?._hydrated === true,
  );
  await page.evaluate(() => {
    const t = (window as unknown as { _testa: Record<string, (...a: unknown[]) => void> })._testa;
    t.trackAddToCart?.(
      [{ item_id: 'SW-MER-NVY-M', product_id: 'SW-MER', price: 89, quantity: 2 }],
      { currency: 'EUR', cart_id: 'c_fs' },
    );
    t.trackPurchase?.({
      order_id: 'ORD-FS-1',
      currency: 'EUR',
      cart_id: 'c_fs',
      items: [
        { item_id: 'SW-MER-NVY-M', product_id: 'SW-MER', price: 89, quantity: 2 },
        { item_id: 'SCF-WL-GRY', price: 49, quantity: 1 },
      ],
      discount: 15.8,
      tax: 37.5,
      coupon: 'AUTUMN10',
    });
  });
  await flushed(page);
  await page.goto('about:blank');

  await waitForRows(
    `SELECT count() AS n FROM events_buffer WHERE project_id = ${projectId} AND event_name = 'purchase'`,
    1,
  );
  await waitForRows(`SELECT count() AS n FROM event_items WHERE project_id = ${projectId}`, 3);
  await chQuery('OPTIMIZE TABLE events_buffer');

  const view = (
    await chQuery<Record<string, unknown>>(
      `SELECT experiment_id, variation_id, exp_ids, exp_var_ids, exp_session_idx, entry_utm_source, entry_utm_medium,
              entry_utm_campaign, click_id_type, channel, referrer_domain, is_bot, os_name, browser_name, screen_w, in_experiment
       FROM events WHERE project_id = ${projectId} AND event_name = 'experiment_view'`,
    )
  )[0] as Record<string, unknown>;
  expect(view).toMatchObject({
    experiment_id: String(experimentId),
    exp_ids: [String(experimentId)],
    exp_var_ids: [String(view.variation_id)],
    exp_session_idx: [1],
    entry_utm_source: 'google',
    entry_utm_medium: 'cpc',
    entry_utm_campaign: 'autumn',
    click_id_type: 'gclid',
    channel: 'Paid Search', // derived at the edge from entry attribution
    referrer_domain: '(direct)',
    is_bot: 0,
    os_name: 'macOS',
    browser_name: 'Chrome',
    in_experiment: 1,
  });
  expect(Number(view.screen_w)).toBeGreaterThan(0);

  const rows = await chQuery<Record<string, unknown>>(
    `SELECT event_name, exp_ids, exp_session_idx, in_experiment, visit_number, order_id, purchase_type,
            toString(value_native) AS value, items_count
     FROM events WHERE project_id = ${projectId} ORDER BY client_ts`,
  );
  // Every event (landing page_view included) carries the experiment session.
  for (const r of rows) {
    expect(r.exp_ids).toEqual([String(experimentId)]);
    expect(r.exp_session_idx).toEqual([1]);
    expect(r.in_experiment).toBe(1);
    expect(r.visit_number).toBe(1);
  }
  expect(rows.map((r) => r.event_name)).toEqual(
    expect.arrayContaining(['page_view', 'experiment_view', 'add_to_cart', 'purchase']),
  );
  expect(rows.find((r) => r.event_name === 'purchase')).toMatchObject({
    order_id: 'ORD-FS-1',
    purchase_type: 'initial',
    value: '211.2',
    items_count: 3,
  });

  const items = await chQuery<Record<string, unknown>>(
    `SELECT event_name, item_id, product_id, quantity, order_id, exp_ids FROM event_items
     WHERE project_id = ${projectId} ORDER BY event_name, item_id`,
  );
  expect(items).toEqual([
    {
      event_name: 'add_to_cart',
      item_id: 'SW-MER-NVY-M',
      product_id: 'SW-MER',
      quantity: 2,
      order_id: '',
      exp_ids: [String(experimentId)],
    },
    {
      event_name: 'purchase',
      item_id: 'SCF-WL-GRY',
      product_id: 'SCF-WL-GRY',
      quantity: 1,
      order_id: 'ORD-FS-1',
      exp_ids: [String(experimentId)],
    },
    {
      event_name: 'purchase',
      item_id: 'SW-MER-NVY-M',
      product_id: 'SW-MER',
      quantity: 2,
      order_id: 'ORD-FS-1',
      exp_ids: [String(experimentId)],
    },
  ]);

  const [leak] = await chQuery<{ n: string }>(
    `SELECT count() AS n FROM events WHERE project_id = ${projectId}
       AND (position(url, '${SECRET}') > 0 OR position(entry_url, '${SECRET}') > 0
            OR position(referrer, '${SECRET}') > 0 OR position(toString(props), '${SECRET}') > 0)`,
  );
  expect(leak?.n).toBe('0');

  const [exposure] = await chQuery<{ v: string; seen: string }>(
    `SELECT toString(argMinMerge(variation_id)) AS v, toString(uniqExactMerge(variations_seen)) AS seen
     FROM exposures WHERE project_id = ${projectId} AND experiment_id = ${experimentId}`,
  );
  expect(exposure).toEqual({ v: String(view.variation_id), seen: '1' });
});

test('v1-only project: unchanged — events sent without exp, nothing dropped', async ({ page }) => {
  const { projectId, experimentId } = ids();
  await boot(page, project(projectId, experimentId), '?page=product');
  await page.evaluate(() =>
    (window as unknown as { _testa: { track: (n: string) => void } })._testa.track('add_to_cart'),
  );
  await flushed(page);
  await page.goto('about:blank');

  await waitForRows(
    `SELECT count() AS n FROM events_buffer WHERE project_id = ${projectId} AND event_name = 'add_to_cart'`,
    1,
  );
  const rows = await chQuery<Record<string, unknown>>(
    `SELECT event_name, exp_ids, in_experiment FROM events_buffer WHERE project_id = ${projectId}`,
  );
  expect(rows.map((r) => r.event_name)).toEqual(
    expect.arrayContaining(['page_view', 'experiment_view', 'add_to_cart']),
  );
  for (const r of rows) {
    expect(r.exp_ids).toEqual([]);
    expect(r.in_experiment).toBe(0);
  }
});
