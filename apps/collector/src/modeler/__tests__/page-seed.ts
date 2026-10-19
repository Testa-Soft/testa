/**
 * Hand-built events for the page-key / count_sq_visitor live tests, with the
 * expected per-variation totals worked out by hand (range 2026-10-01..03).
 *
 *   var 100: vA exposed 10:00; page_views /thanks 09:00 (pre-exposure, out),
 *            /thanks 10:05, /thanks?order=1 10:06, /p/123 10:07, /cart 10:08
 *            vB exposed, nothing else
 *            vE exposed; /thanks on 10-05 (after `to` + 1 day, out)
 *   var 101: vC exposed; /thanks ×3
 *            vD exposed; /thanks stamped with ANOTHER experiment (out)
 *            vF exposed; /thanks ×1, sign_up ×2
 */
import { randomUUID } from 'node:crypto';
import type { MetricKey } from '@testa-platform/shared-types';
import { insertRows } from '../../db/clickhouse.ts';

export const FROM = '2026-10-01';
export const TO = '2026-10-03';
const HOST = 'https://shop.example';
const SESSION_START = 1_790_848_800; // 2026-10-01 10:00:00 UTC

export const PAGE_KEYS = {
  exact: `page:exact:${encodeURIComponent(`${HOST}/thanks`)}`,
  contains: `page:contains:${encodeURIComponent('/thanks')}`,
  startsWith: `page:starts_with:${encodeURIComponent(`${HOST}/thanks`)}`,
  regex: `page:regex:${encodeURIComponent('/p/\\d+$')}`,
} as const satisfies Record<string, MetricKey>;

export const SEED_KEYS: MetricKey[] = [...Object.values(PAGE_KEYS), 'page_view', 'sign_up'];

/** Expected totals per variation × key: [converted, count, count_sq_visitor]. visitors = 3 each. */
export const EXPECTED: Record<number, Record<string, [number, number, number]>> = {
  100: {
    [PAGE_KEYS.exact]: [1, 1, 1],
    [PAGE_KEYS.contains]: [1, 2, 4],
    [PAGE_KEYS.startsWith]: [1, 2, 4],
    [PAGE_KEYS.regex]: [1, 1, 1],
    page_view: [1, 4, 16],
    sign_up: [0, 0, 0],
  },
  101: {
    [PAGE_KEYS.exact]: [2, 4, 10],
    [PAGE_KEYS.contains]: [2, 4, 10],
    [PAGE_KEYS.startsWith]: [2, 4, 10],
    [PAGE_KEYS.regex]: [0, 0, 0],
    page_view: [2, 4, 10],
    sign_up: [1, 2, 4],
  },
};

interface Ev {
  visitor: string;
  ts: string;
  name: string;
  path?: string;
  variation: number;
  experiments?: number[];
}

function row(projectId: number, experimentId: number, e: Ev) {
  const exps = e.experiments ?? [experimentId];
  return {
    event_id: randomUUID(),
    client_ts: e.ts,
    server_ts: e.ts,
    project_id: projectId,
    visitor_id: e.visitor,
    session_id: `s-${e.visitor}`,
    event_name: e.name,
    url: `${HOST}${e.path ?? '/'}`,
    in_experiment: 1,
    exp_ids: exps,
    exp_var_ids: exps.map(() => e.variation),
    exp_session_starts: exps.map(() => SESSION_START),
    ...(e.name === 'experiment_view'
      ? { experiment_id: experimentId, variation_id: e.variation }
      : {}),
  };
}

const D1 = '2026-10-01';
const view = (visitor: string, variation: number): Ev => ({
  visitor,
  variation,
  ts: `${D1} 10:00:00.000`,
  name: 'experiment_view',
});
const pv = (
  visitor: string,
  variation: number,
  ts: string,
  path: string,
  experiments?: number[],
): Ev => ({
  visitor,
  variation,
  ts,
  name: 'page_view',
  path,
  ...(experiments ? { experiments } : {}),
});

export async function seedPageEvents(projectId: number, experimentId: number): Promise<void> {
  const other = experimentId + 1;
  const evs: Ev[] = [
    view('vA', 100),
    pv('vA', 100, `${D1} 09:00:00.000`, '/thanks'),
    pv('vA', 100, `${D1} 10:05:00.000`, '/thanks'),
    pv('vA', 100, `${D1} 10:06:00.000`, '/thanks?order=1'),
    pv('vA', 100, `${D1} 10:07:00.000`, '/p/123'),
    pv('vA', 100, `${D1} 10:08:00.000`, '/cart'),
    view('vB', 100),
    view('vE', 100),
    pv('vE', 100, '2026-10-05 10:00:00.000', '/thanks'),
    view('vC', 101),
    pv('vC', 101, `${D1} 10:01:00.000`, '/thanks'),
    pv('vC', 101, `${D1} 10:02:00.000`, '/thanks'),
    pv('vC', 101, `${D1} 10:03:00.000`, '/thanks'),
    view('vD', 101),
    pv('vD', 101, `${D1} 10:04:00.000`, '/thanks', [other]),
    view('vF', 101),
    pv('vF', 101, `${D1} 10:05:00.000`, '/thanks'),
    { visitor: 'vF', variation: 101, ts: `${D1} 10:06:00.000`, name: 'sign_up' },
    { visitor: 'vF', variation: 101, ts: `${D1} 10:07:00.000`, name: 'sign_up' },
  ];
  await insertRows(
    'events',
    evs.map((e) => row(projectId, experimentId, e)),
  );
}
