/**
 * Unit: every tracking query bounds `client_ts` (the partition + sort key of
 * `events`) next to its `server_ts` window, so ClickHouse can prune.
 */
import { describe, expect, it } from 'bun:test';
import type { QueryRunner } from '../../analytics/attribution.ts';
import { fetchTrackingEvents } from '../events.ts';
import { LOOKBACK_MS, RECENT_MS, chTime } from '../params.ts';

const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);

async function capture() {
  const calls: { sql: string; params: Record<string, unknown> }[] = [];
  const run: QueryRunner = async <T>(sql: string, params: Record<string, unknown>) => {
    calls.push({ sql, params });
    return [] as T[];
  };
  const res = await fetchTrackingEvents(run, 7, ['purchase'], NOW);
  return { calls, res };
}

const fromEventsBuffer = (sql: string) => sql.includes('FROM events_buffer AS a');

describe('fetchTrackingEvents — client_ts pruning bounds', () => {
  it('runs three queries, each over events_buffer', async () => {
    const { calls } = await capture();
    expect(calls).toHaveLength(3);
    for (const c of calls) expect(fromEventsBuffer(c.sql)).toBe(true);
  });

  it('bounds the 30-day events query on client_ts with a 1-day margin', async () => {
    const { calls } = await capture();
    const events = calls.find((c) => c.sql.includes('AS received_24h'));
    expect(events?.sql).toContain('a.server_ts >= {lookback:DateTime64(3)}');
    expect(events?.sql).toContain('a.client_ts >= {lookback:DateTime64(3)} - INTERVAL 1 DAY');
  });

  it('bounds the props and items (24 h) queries on client_ts with a 1-day margin', async () => {
    const { calls } = await capture();
    const recent = calls.filter((c) => !c.sql.includes('AS received_24h'));
    expect(recent).toHaveLength(2);
    for (const c of recent) {
      expect(c.sql).toContain('a.server_ts >= {recent:DateTime64(3)}');
      expect(c.sql).toContain('a.client_ts >= {recent:DateTime64(3)} - INTERVAL 1 DAY');
    }
  });

  it('passes the recent / lookback window params', async () => {
    const { calls } = await capture();
    for (const c of calls) {
      expect(c.params.recent).toBe(chTime(NOW - RECENT_MS));
      expect(c.params.lookback).toBe(chTime(NOW - LOOKBACK_MS));
    }
  });

  it('returns an empty event entry when nothing matched', async () => {
    const { res } = await capture();
    expect(res.events[0]).toMatchObject({
      event: 'purchase',
      last_received_at: null,
      received_24h: 0,
    });
  });
});
