/** Harness unit tests (task 5.14): args, flow selection, F2 generator, wire encoding, report. */
import { describe, expect, it } from 'bun:test';
import { FIXTURES, parseArgs } from '../config.ts';
import { F2_EXPERIMENTS, generateF2 } from '../fixtures/f2-generator.ts';
import { select } from '../flows.ts';
import { simToWire } from '../ingest.ts';
import { renderReport } from '../report.ts';

describe('args', () => {
  it('defaults: port 8090, compose on outside CI', () => {
    const a = parseArgs([]);
    expect(a.port).toBe(8090);
    expect(a.only).toBeNull();
    expect(a.dryRun).toBe(false);
  });

  it('--only, --port, flags', () => {
    const a = parseArgs(['--only', 'v1,F2', '--port=8093', '--keep-up', '--dry-run']);
    expect([...(a.only ?? [])]).toEqual(['V1', 'F2']);
    expect(a.port).toBe(8093);
    expect(a.keepUp && a.dryRun).toBe(true);
  });

  it('rejects unknown ids and arguments', () => {
    expect(() => parseArgs(['--only', 'V99'])).toThrow('unknown V99');
    expect(() => parseArgs(['--port', '0'])).toThrow();
    expect(() => parseArgs(['--nope'])).toThrow();
  });
});

describe('select', () => {
  it('everything by default, in execution order (V3 after the F1 reads)', () => {
    const s = select(null);
    expect(s.flows).toHaveLength(17);
    const ids = s.flows.map((f) => f.id);
    expect(ids.indexOf('V3')).toBeGreaterThan(ids.indexOf('V14'));
    expect([...s.fixtures].sort()).toEqual(['F1', 'F2', 'F3']);
  });

  it('flow ids load their fixtures', () => {
    const s = select(new Set(['V1', 'V7']));
    expect(s.flows.map((f) => f.id)).toEqual(['V1', 'V7']);
    expect([...s.fixtures].sort()).toEqual(['F1', 'F2', 'F3']);
  });

  it('a fixture id selects its flows but loads only that fixture', () => {
    const s = select(new Set(['F3']));
    expect(s.flows.map((f) => f.id).sort()).toEqual(['V15', 'V7']);
    expect([...s.fixtures]).toEqual(['F3']);
  });

  it('the CI subset', () => {
    const s = select(new Set(['V1', 'V2', 'V3', 'V5', 'V7', 'V8']));
    expect(s.flows).toHaveLength(6);
  });
});

describe('F2 generator', () => {
  const sim = generateF2(FIXTURES.F2.projectId);
  const visitors = new Set(sim.events.map((e) => e.visitor_id));
  const views = sim.events.filter((e) => e.event_name === 'experiment_view');
  const purchases = sim.events.filter((e) => e.event_name === 'purchase');

  it('is deterministic for seed 1717', () => {
    const again = generateF2(FIXTURES.F2.projectId);
    expect(again.events.length).toBe(sim.events.length);
    expect(again.events.at(-1)).toEqual(sim.events.at(-1) as (typeof sim.events)[number]);
  });

  it('≈ 20,000 visitors, 2 experiments × 3 variations, 7 days, 25 cities', () => {
    expect(visitors.size).toBeGreaterThan(19_000);
    expect(visitors.size).toBeLessThan(21_000);
    for (const e of F2_EXPERIMENTS) {
      const vars = new Set(
        views.filter((v) => v.experiment_id === e.id).map((v) => v.variation_id),
      );
      expect([...vars].sort()).toEqual([...e.variations]);
    }
    expect(new Set(views.map((v) => v.client_ts.slice(0, 10))).size).toBe(7);
    expect(new Set(views.map((v) => v.city)).size).toBe(25);
    expect(new Set(views.map((v) => v.channel)).size).toBe(6);
  });

  it('repeat sessions, bots, contamination, reloads, upsells, currencies, outside-session events', () => {
    const share = (n: number) => n / visitors.size;
    const sessions = new Map<string, Set<number>>();
    for (const v of views) {
      const set = sessions.get(v.visitor_id) ?? new Set<number>();
      for (const s of v.exp_session_starts) set.add(s);
      sessions.set(v.visitor_id, set);
    }
    expect(share([...sessions.values()].filter((s) => s.size >= 2).length)).toBeGreaterThan(0.15);
    expect(
      share(new Set(sim.events.filter((e) => e.is_bot === 1).map((e) => e.visitor_id)).size),
    ).toBeCloseTo(0.01, 2);
    const seen = new Map<string, Set<number | null>>();
    for (const v of views.filter((x) => x.experiment_id === 2001)) {
      seen.set(v.visitor_id, (seen.get(v.visitor_id) ?? new Set()).add(v.variation_id));
    }
    const contaminated = [...seen.values()].filter((s) => s.size > 1).length;
    expect(contaminated).toBeGreaterThan(0);
    expect(share(contaminated)).toBeLessThan(0.01);
    const initial = purchases.filter((p) => p.purchase_type === 'initial');
    const orders = new Set(initial.map((p) => p.order_id));
    const reloads = initial.length - orders.size;
    expect(reloads / orders.size).toBeGreaterThan(0.015);
    expect(reloads / orders.size).toBeLessThan(0.05);
    const upsells = purchases.filter((p) => p.purchase_type === 'upsell').length;
    expect(upsells / orders.size).toBeGreaterThan(0.1);
    expect(upsells / orders.size).toBeLessThan(0.2);
    expect(new Set(purchases.map((p) => p.currency))).toEqual(new Set(['EUR', 'USD', 'GBP']));
    expect(sim.events.some((e) => e.exp_ids.length === 0)).toBe(true);
    expect(views.some((v) => v.exp_ids.length === 2)).toBe(true);
  });

  it('encodes to wire events with exp tuples and session_idx', () => {
    const wire = simToWire({ events: sim.events.slice(0, 2_000), items: sim.items });
    expect(wire).toHaveLength(2_000);
    const withExp = wire.find((w) => Array.isArray(w.exp) && (w.exp as unknown[]).length > 0);
    expect((withExp?.exp as number[][])[0]).toHaveLength(4);
    expect(wire.every((w) => w.project_id === FIXTURES.F2.projectId)).toBe(true);
  });
});

describe('report', () => {
  it('renders a summary and one table per flow, flow status from its checks', () => {
    const md = renderReport(
      [
        {
          id: 'V2',
          title: 'Attribution rules',
          data: 'F1',
          ms: 1200,
          checks: [
            { name: 'quality', status: 'fail', detail: 'x', expected: 1, actual: 2, ms: 10 },
          ],
        },
        {
          id: 'V1',
          title: 'Ingest',
          data: 'F1',
          ms: 900,
          checks: [{ name: 'rows', status: 'pass', detail: 'ok', ms: 5 }],
        },
        {
          id: 'V9',
          title: 'Pixel',
          data: 'page',
          ms: 1,
          checks: [{ name: 'p', status: 'pending', pendingOn: 'P1', detail: 'missing', ms: 1 }],
        },
      ],
      {
        startedAt: new Date(0),
        ms: 5000,
        commit: 'abc1234',
        args: '--only V1',
        setup: ['stack up'],
      },
    );
    expect(md).toContain('**1 passed · 1 failed · 1 pending · 0 skipped**');
    expect(md.indexOf('## V1 —')).toBeLessThan(md.indexOf('## V2 —'));
    expect(md).toContain('| V2 | Attribution rules | F1 | ❌ fail | 0/1 |');
    expect(md).toContain('⏳ pending-P1');
  });
});
