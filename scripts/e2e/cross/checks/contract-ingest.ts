/**
 * Layer `contract`, part 1: fixtures F1 + F3 enter through the REAL ingest
 * path (HMAC `/_ingest` → Redis → consumer → events_buffer → events), and V1
 * (the stored row carries what was sent).
 */

import { type CheckDef, Diff, fail, pass, pending } from '../lib/check.ts';
import { chColumns, chQuery, chTableExists } from '../lib/clickhouse.ts';
import { type WireEvent, loadF1WireEvents } from '../shared/f1-wire.ts';
import { buildF3WireEvents } from '../shared/f3-wire.ts';
import { ingestEvents, waitForEventRows } from '../shared/ingest-client.ts';

const F1_VISITORS =
  "visitor_id IN ('v1','v2','v3','v4','v5','v6','v7','v8','v9') AND project_id = 42";

const V1_COLUMNS = [
  'exp_ids',
  'exp_var_ids',
  'exp_session_starts',
  'exp_session_idx',
  'purchase_type',
  'parent_order_id',
  'entry_url',
  'channel',
  'os_name',
  'browser_name',
] as const;

type ExpTuple = readonly [number, number, number, number];

interface StoredRow {
  readonly event_id: string;
  readonly [column: string]: unknown;
}

function expectedColumns(ev: WireEvent): Record<string, unknown> {
  const exp = (ev.exp ?? []) as readonly ExpTuple[];
  const str = (k: string): string => (typeof ev[k] === 'string' ? (ev[k] as string) : '');
  return {
    exp_ids: exp.map((t) => t[0]),
    exp_var_ids: exp.map((t) => t[1]),
    exp_session_starts: exp.map((t) => t[2]),
    exp_session_idx: exp.map((t) => t[3]),
    purchase_type: str('purchase_type'),
    parent_order_id: str('parent_order_id'),
    entry_url: str('entry_url'),
    channel: str('channel'),
    os_name: str('os_name'),
    browser_name: str('browser_name'),
  };
}

/** ClickHouse returns DateTime / UInt64 arrays as strings or numbers depending on type. */
function normalize(column: string, value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => {
      if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2} /.test(v))
        return Math.floor(Date.parse(`${v.replace(' ', 'T')}Z`) / 1000);
      return typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
    });
  }
  return column.startsWith('exp_') && value === null ? [] : value;
}

export const contractIngestChecks: readonly CheckDef[] = [
  {
    id: 'contract.f1-ingest',
    layer: 'contract',
    title: 'F1 (29 events) ingested via HMAC /_ingest and flushed to events',
    owner: 'P2',
    dod: ['V1', 'V2', 'X1'],
    needs: ['smoke.ingest-roundtrip'],
    async run({ cfg, facts }) {
      const f1 = loadF1WireEvents(cfg.args.platformDir);
      const res = await ingestEvents(cfg.collector.url, cfg.secrets.ingest, f1.events);
      const d = new Diff()
        .eq('accepted', f1.events.length, res.accepted)
        .eq('deduplicated by event_id (v1 reload has its own event_id)', 0, res.deduplicated);
      if (!d.ok) return d.outcome('');
      const n = await waitForEventRows(cfg.clickhouse, F1_VISITORS, f1.events.length, 90_000);
      facts.set('f1.events', f1.events);
      facts.set('f1.itemRows', f1.itemRows);
      return pass(`${n} F1 rows in ${cfg.clickhouse.database}.events (${res.batches} batch)`);
    },
  },
  {
    id: 'contract.f3-ingest',
    layer: 'contract',
    title: 'F3 (14,229 exposures + 361 purchases, experiment 1903) ingested and flushed',
    owner: 'P2',
    dod: ['V7', 'V15', 'crobot §9 F3 label'],
    needs: ['smoke.ingest-roundtrip'],
    async run({ cfg }) {
      const events = buildF3WireEvents(cfg.ids.projectId, cfg.ids.f3);
      const res = await ingestEvents(cfg.collector.url, cfg.secrets.ingest, events);
      if (res.accepted !== events.length)
        return fail('ingest accepted count', events.length, res.accepted);
      const n = await waitForEventRows(
        cfg.clickhouse,
        `visitor_id LIKE 'f3-${cfg.ids.f3}-%'`,
        events.length,
        120_000,
      );
      return pass(`${n} F3 rows flushed (${res.batches} batches of ≤500)`);
    },
  },
  {
    id: 'contract.v1-row-shape',
    layer: 'contract',
    title:
      'V1: stored events carry exp_* / purchase_type / parent_order_id / entry_* / channel / os_name / browser_name as sent; event_items per item',
    owner: 'P0+P2',
    dod: ['V1'],
    needs: ['contract.f1-ingest'],
    async run({ cfg, facts }) {
      const columns = await chColumns(cfg.clickhouse, 'events');
      const missing = V1_COLUMNS.filter((c) => !columns.has(c));
      if (missing.length > 0)
        return pending('P0', `events lacks columns ${missing.join(', ')} (migrations 013+)`);
      if (!(await chTableExists(cfg.clickhouse, 'event_items')))
        return pending('P0', 'event_items table missing');
      const events = facts.get('f1.events') as readonly WireEvent[];
      const rows = await chQuery<StoredRow>(
        cfg.clickhouse,
        `SELECT event_id, ${V1_COLUMNS.join(', ')} FROM events WHERE ${F1_VISITORS}`,
      );
      const byId = new Map(rows.map((r) => [r.event_id, r]));
      if (rows.every((r) => (normalize('exp_ids', r.exp_ids) as unknown[]).length === 0)) {
        return pending(
          'P2',
          'exp_ids empty on every F1 row — consumer row-mapper does not map `exp` yet (5.4)',
        );
      }
      const d = new Diff();
      for (const ev of events) {
        const row = byId.get(ev.event_id);
        if (row === undefined) {
          d.truthy(`row for ${ev.event_id}`, false);
          continue;
        }
        for (const [col, want] of Object.entries(expectedColumns(ev))) {
          d.eq(`${ev.visitor_id} ${ev.event_name} ${col}`, want, normalize(col, row[col]));
        }
      }
      const firstO1 = events.find((e) => e.order_id === 'O1');
      const items = await chQuery<{ n: string }>(
        cfg.clickhouse,
        `SELECT count() AS n FROM event_items WHERE event_id = '${firstO1?.event_id}'`,
      );
      d.eq('event_items rows for v1 purchase O1 (one per item)', 1, Number(items[0]?.n ?? 0));
      const allItems = await chQuery<{ n: string }>(
        cfg.clickhouse,
        `SELECT count() AS n FROM event_items WHERE event_id IN (SELECT event_id FROM events WHERE ${F1_VISITORS})`,
      );
      d.eq(
        'event_items rows for all F1 events',
        facts.get('f1.itemRows'),
        Number(allItems[0]?.n ?? 0),
      );
      return d.outcome(`${events.length} F1 rows match the wire payload`);
    },
  },
];
