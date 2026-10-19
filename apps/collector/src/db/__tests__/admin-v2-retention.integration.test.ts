/**
 * Admin v2 retention (migration 024) + metric_daily.count_sq_visitor (025)
 * against a real ClickHouse.
 *
 * TTL behaviour is checked on a throwaway clone of `events` (`CREATE TABLE …
 * AS events` copies engine, ORDER BY and TTL), so forcing TTL with
 * `OPTIMIZE … FINAL` never touches fixture rows other suites seeded.
 *
 *   CLICKHOUSE_URL=http://localhost:8123 CLICKHOUSE_DATABASE=admin_v2_collector bun test admin-v2-retention
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { database, live, prepareDatabase } from '../../modeler/__tests__/live.ts';
import { command, insertRows, query } from '../clickhouse.ts';

const PROBE = `ttl_probe_${randomUUID().replaceAll('-', '')}`;
const DAY_MS = 86_400_000;

const chTs = (msAgo: number): string =>
  new Date(Date.now() - msAgo).toISOString().replace('T', ' ').replace('Z', '');

function row(name: string, inExperiment: 0 | 1, daysAgo: number, tag: string) {
  return {
    event_id: randomUUID(),
    client_ts: chTs(daysAgo * DAY_MS),
    server_ts: chTs(daysAgo * DAY_MS),
    project_id: 1,
    visitor_id: tag,
    session_id: 's',
    event_name: name,
    url: 'https://shop.example/',
    in_experiment: inExperiment,
  };
}

describe.skipIf(!live)(`admin v2 retention (live ClickHouse, db=${database})`, () => {
  beforeAll(async () => {
    await prepareDatabase();
    await command(`CREATE TABLE ${PROBE} AS events`);
  });

  afterAll(async () => {
    await command(`DROP TABLE IF EXISTS ${PROBE}`);
  });

  it('events TTL: 1 day for non-experiment page_view, 13 months for in-experiment page_view', async () => {
    const [ddl] = await query<{ create_table_query: string }>(
      `SELECT create_table_query FROM system.tables
       WHERE database = currentDatabase() AND name = 'events'`,
    );
    const ttl = ddl?.create_table_query ?? '';
    expect(ttl).toContain(
      "toIntervalMonth(13) WHERE (event_name = 'page_view') AND (in_experiment = 1)",
    );
    expect(ttl).toContain(
      "toIntervalDay(1) WHERE (event_name = 'page_view') AND (in_experiment = 0)",
    );
    expect(ttl).not.toContain('toIntervalDay(90)');
  });

  it('forced TTL keeps in-experiment page_views for 13 months, reaps the rest on schedule', async () => {
    await insertRows(PROBE, [
      row('page_view', 1, 100, 'pv_exp_100d'), // was reaped at 90 days before 024
      row('page_view', 1, 370, 'pv_exp_370d'), // inside 13 months
      row('page_view', 1, 420, 'pv_exp_420d'), // past 13 months
      row('page_view', 0, 3, 'pv_noexp_3d'), // non-experiment: 1 day
      row('page_view', 0, 0, 'pv_noexp_now'),
      row('purchase', 0, 100, 'purchase_100d'),
    ]);
    await command(`OPTIMIZE TABLE ${PROBE} FINAL`);
    const kept = await query<{ visitor_id: string }>(
      `SELECT visitor_id FROM ${PROBE} ORDER BY visitor_id`,
    );
    expect(kept.map((r) => r.visitor_id)).toEqual([
      'purchase_100d',
      'pv_exp_100d',
      'pv_exp_370d',
      'pv_noexp_now',
    ]);
  });

  it('events_buffer still mirrors in_experiment (rows keep their TTL tier on flush)', async () => {
    const cols = await query<{ name: string }>(
      `SELECT name FROM system.columns
       WHERE database = currentDatabase() AND table = 'events_buffer' AND name = 'in_experiment'`,
    );
    expect(cols).toHaveLength(1);
  });

  it('metric_daily has count_sq_visitor (025)', async () => {
    const cols = await query<{ name: string; type: string }>(
      `SELECT name, type FROM system.columns
       WHERE database = currentDatabase() AND table = 'metric_daily' AND name = 'count_sq_visitor'`,
    );
    expect(cols).toEqual([{ name: 'count_sq_visitor', type: 'Float64' }]);
  });
});
