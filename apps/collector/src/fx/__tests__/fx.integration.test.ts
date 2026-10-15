/**
 * FX previous-day lookup + backfill (task 5.19) against a real ClickHouse,
 * with a fake Frankfurter served over real HTTP. Dates are in 2031 so no other
 * fixture's rates interfere.
 *
 *   CLICKHOUSE_URL=http://localhost:8123 CLICKHOUSE_DATABASE=prd006_p2 bun test src/fx
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createClient } from '@clickhouse/client';
import type { Server } from 'bun';
import { config } from '../../config.ts';
import { insertRows, query } from '../../db/clickhouse.ts';
import { migrate } from '../../db/migrate.ts';
import { computeDailyRows } from '../../modeler/daily-rows.ts';
import { backfill } from '../backfill.ts';
import { daysWithRates } from '../store.ts';
import { syncToday } from '../sync.ts';

const live = Boolean(process.env.CLICKHOUSE_URL) && config.clickhouse.database !== 'default';
const run = <T>(sql: string, params: Record<string, unknown>) => query<T>(sql, params);

// Fake ECB/Frankfurter: business days only (Fri 3rd, Mon 6th); USD→EUR differs per day.
const SERIES: Record<string, Record<string, number>> = {
  '2031-01-02': { EUR: 0.7, GBP: 0.6 },
  '2031-01-03': { EUR: 0.8, GBP: 0.65 },
  '2031-01-06': { EUR: 0.9, GBP: 0.7 },
};
let server: Server;
let api: string;
const calls: string[] = [];

async function rateOn(day: string, ccy: string): Promise<number | undefined> {
  const [row] = await run<{ rate: number }>(
    `SELECT rate FROM fx_rates_history FINAL WHERE date = toDate({d:String}) AND from_ccy = 'USD' AND to_ccy = {c:String}`,
    { d: day, c: ccy },
  );
  return row?.rate;
}

describe.skipIf(!live)(`FX previous-day + backfill (db=${config.clickhouse.database})`, () => {
  beforeAll(async () => {
    const admin = createClient({
      url: config.clickhouse.url,
      username: config.clickhouse.user,
      password: config.clickhouse.password,
    });
    await admin.command({ query: `CREATE DATABASE IF NOT EXISTS ${config.clickhouse.database}` });
    await admin.close();
    await migrate();
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        calls.push(url.pathname);
        if (url.pathname === '/latest') {
          return Response.json({
            amount: 1,
            base: 'USD',
            date: '2031-01-06',
            rates: SERIES['2031-01-06'],
          });
        }
        const m = /^\/(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(url.pathname);
        if (!m) return new Response('not found', { status: 404 });
        const [, from = '', to = ''] = m;
        const rates = Object.fromEntries(
          Object.entries(SERIES).filter(([d]) => d >= from && d <= to),
        );
        return Response.json({ amount: 1, base: 'USD', start_date: from, end_date: to, rates });
      },
    });
    api = `http://localhost:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  it('backfill fills weekends with Friday’s rates and is idempotent', async () => {
    // Earlier runs may already have written these days (idempotent by design).
    await backfill('2031-01-03', '2031-01-06', { apiUrl: api });
    const days = await daysWithRates('2031-01-03', '2031-01-06');
    expect([...days].sort()).toEqual(['2031-01-03', '2031-01-04', '2031-01-05', '2031-01-06']);
    expect(await rateOn('2031-01-04', 'EUR')).toBe(0.8); // Saturday ← Friday
    expect(await rateOn('2031-01-05', 'EUR')).toBe(0.8); // Sunday ← Friday
    expect(await rateOn('2031-01-06', 'EUR')).toBe(0.9);
    expect(await rateOn('2031-01-05', 'USD')).toBe(1);

    const before = calls.length;
    expect(await backfill('2031-01-03', '2031-01-06', { apiUrl: api })).toEqual([]);
    expect(calls.length).toBe(before); // nothing missing → no fetch
  });

  it('orders: weekend uses Friday’s rate, a missing day falls back, unknown currency is excluded and counted', async () => {
    await backfill('2031-01-03', '2031-01-06', { apiUrl: api });
    const projectId = 300_000_000 + Math.floor(Math.random() * 99_000_000);
    const experimentId = 1717;
    const base = {
      project_id: projectId,
      visitor_id: 'fx-v',
      session_id: 's',
      url: 'https://shop.example/',
      exp_ids: [experimentId],
      exp_var_ids: [100],
      exp_session_starts: [1],
    };
    const purchase = (ts: string, value: number, currency: string) => ({
      ...base,
      event_id: randomUUID(),
      event_name: 'purchase',
      client_ts: ts,
      order_id: `o-${randomUUID()}`,
      purchase_type: 'initial',
      value_native: value,
      currency,
    });
    await insertRows('events', [
      {
        ...base,
        event_id: randomUUID(),
        event_name: 'experiment_view',
        client_ts: '2031-01-05 08:00:00.000',
        experiment_id: experimentId,
        variation_id: 100,
      },
      // Monday order → previous day Sunday → carried Friday rate 0.8: $100 → €80.
      purchase('2031-01-06 10:00:00.000', 100, 'USD'),
      // Saturday 11th → Friday 10th has no row (no backfill) → last known (Mon 6th, 0.9): $100 → €90.
      purchase('2031-01-11 10:00:00.000', 100, 'USD'),
      // Unknown currency: no rate → excluded from the sum, counted in quality.
      purchase('2031-01-07 10:00:00.000', 500, 'XYZ'),
      // Same currency: rate 1.
      purchase('2031-01-07 11:00:00.000', 10, 'EUR'),
    ]);
    const result = await computeDailyRows(run, {
      projectId,
      experimentId,
      from: '2031-01-05',
      to: '2031-01-11',
      reportCurrency: 'EUR',
      metrics: ['purchase', 'revenue'],
    });
    const purchaseRow = result.rows.find((r) => r.metric_key === 'purchase');
    expect(purchaseRow?.count).toBe(4);
    expect(purchaseRow?.sum).toBe(180); // 80 + 90 + 10 (XYZ left out)
    expect(result.quality.unconvertible_orders).toBe(1);
  });

  it('syncToday stores the latest rates and backfills the window', async () => {
    const n = await syncToday({
      fetchFn: (input) => fetch(String(input).replace(config.fxApiUrl, api)),
      backfillDays: 5,
      now: () => Date.parse('2031-01-06T12:00:00Z'),
    });
    expect(n).toBe(3); // EUR, GBP + USD identity
    const days = await daysWithRates('2031-01-01', '2031-01-06');
    // Jan 1 has no earlier business day in the fake series → stays empty; the rest are filled.
    expect([...days].sort()).toEqual([
      '2031-01-02',
      '2031-01-03',
      '2031-01-04',
      '2031-01-05',
      '2031-01-06',
    ]);
  });
});
