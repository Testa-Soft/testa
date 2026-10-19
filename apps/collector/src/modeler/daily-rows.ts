/**
 * Daily rows builder (PRD-006 §2.2–2.4, task 5.9): raw events → additive rows,
 * one per first-exposure date × variation (× dimension value) × metric key.
 * Rows only carry visitors / converted / count / sum / sum_sq / sum_sq_visitor /
 * count_sq_visitor;
 * crobot sums any range and divides. Reference: generate.py `daily_summary`.
 */
import type {
  DailyRow,
  DimensionKey,
  DimensionRow,
  MetricKey,
  QualityBlock,
} from '@testa-platform/shared-types';
import { type QueryRunner, fetchQuality } from '../analytics/attribution.ts';
import { SyncApiError } from '../analytics/errors.ts';
import {
  buildCapQuery,
  buildDailyRowsQuery,
  buildUnconvertibleQuery,
  keyColumn,
} from './daily-rows-sql.ts';
import { PAYMENT_TYPE_KEYS, type ParsedKey, parseMetrics } from './metric-keys.ts';
import { roundHalfEven } from './round.ts';

export interface DailyRowsParams {
  projectId: number;
  experimentId: number;
  from: string;
  to: string;
  reportCurrency: string;
  metrics: readonly MetricKey[];
  dimension?: DimensionKey;
  capOutliers?: boolean;
  /** Row order for variations (project-config order); default ascending id. */
  variationOrder?: readonly number[];
}

export type DailyRowsResult =
  | { dimension: null; rows: DailyRow[]; quality: QualityBlock }
  | { dimension: DimensionKey; rows: DimensionRow[]; quality: QualityBlock };

export const TOP_N = 10;
export const OTHER = '(other)';
const MAX_SPAN_DAYS = 400;
const CURRENCY_RE = /^[A-Z]{3}$/;
const DAY_MS = 86_400_000;
const FIELDS = ['c', 'n', 's', 'q', 'v', 'w'] as const;

type Acc = { visitors: number; vals: number[] };
type WideRow = Record<string, string | number>;

/** Validates the scope fields shared by the modeler, the summary view and the sync API. */
export function assertRange(from: string, to: string): void {
  const f = Date.parse(`${from}T00:00:00Z`);
  const t = Date.parse(`${to}T00:00:00Z`);
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRe.test(from) || Number.isNaN(f)) throw new SyncApiError('invalid_range', 400, 'from');
  if (!dateRe.test(to) || Number.isNaN(t)) throw new SyncApiError('invalid_range', 400, 'to');
  if (f > t || (t - f) / DAY_MS > MAX_SPAN_DAYS)
    throw new SyncApiError('invalid_range', 400, 'from');
}

export function assertCurrency(ccy: unknown): string {
  if (typeof ccy !== 'string' || !CURRENCY_RE.test(ccy)) {
    throw new SyncApiError('invalid_currency', 400, 'report_currency');
  }
  return ccy;
}

function assertDimensionKeys(
  dimension: DimensionKey | undefined,
  keys: readonly ParsedKey[],
): void {
  if (dimension !== 'payment_type') return;
  const bad = keys.find((k) => !PAYMENT_TYPE_KEYS.includes(k.key));
  if (bad) throw new SyncApiError('unknown_metric', 400, bad.key);
}

/** quality + `unconvertible_orders` (only when > 0, so goldens stay exact). */
async function fetchQualityBlock(run: QueryRunner, p: DailyRowsParams): Promise<QualityBlock> {
  const q = buildUnconvertibleQuery(p);
  const [base, rows] = await Promise.all([
    fetchQuality(run, p),
    run<{ n: string | number }>(q.sql, q.params),
  ]);
  const unconvertible = Number(rows[0]?.n ?? 0);
  return unconvertible > 0 ? { ...base, unconvertible_orders: unconvertible } : base;
}

async function fetchCap(run: QueryRunner, p: DailyRowsParams): Promise<number | undefined> {
  const q = buildCapQuery(p);
  const [row] = await run<{ cap: number; orders: string | number }>(q.sql, q.params);
  return row && Number(row.orders) > 0 ? Number(row.cap) : undefined;
}

/** Top N dimension values by visitors (all dates/variations); ties → earliest first exposure. */
function topValues(wide: readonly WideRow[]): Set<string> {
  const byValue = new Map<string, { visitors: number; first: string }>();
  for (const r of wide) {
    const dv = String(r.dv);
    const cur = byValue.get(dv) ?? { visitors: 0, first: String(r.dv_first) };
    byValue.set(dv, {
      visitors: cur.visitors + Number(r.visitors),
      first: String(r.dv_first) < cur.first ? String(r.dv_first) : cur.first,
    });
  }
  const ranked = [...byValue.entries()].sort(
    ([, a], [, b]) => b.visitors - a.visitors || a.first.localeCompare(b.first),
  );
  return new Set(ranked.slice(0, TOP_N).map(([dv]) => dv));
}

/** Sum wide rows per (date, variation, folded value); every field is additive. */
function fold(wide: readonly WideRow[], keyCount: number, top: Set<string> | null) {
  const groups = new Map<string, { date: string; variation: number; dv: string; acc: Acc }>();
  for (const r of wide) {
    const dv = top === null ? '' : top.has(String(r.dv)) ? String(r.dv) : OTHER;
    const id = `${r.date}|${r.variation_id}|${dv}`;
    const g = groups.get(id) ?? {
      date: String(r.date),
      variation: Number(r.variation_id),
      dv,
      acc: { visitors: 0, vals: new Array<number>(keyCount * FIELDS.length).fill(0) },
    };
    const vals = g.acc.vals.map((v, j) => {
      const field = FIELDS[j % FIELDS.length] as (typeof FIELDS)[number];
      return v + Number(r[keyColumn(Math.floor(j / FIELDS.length), field)] ?? 0);
    });
    groups.set(id, { ...g, acc: { visitors: g.acc.visitors + Number(r.visitors), vals } });
  }
  return [...groups.values()];
}

function rowsFrom(
  groups: ReturnType<typeof fold>,
  keys: readonly ParsedKey[],
  dimension: DimensionKey | undefined,
  variationOrder: readonly number[] | undefined,
): (DailyRow | DimensionRow)[] {
  const vIndex = (v: number): number => {
    const i = variationOrder?.indexOf(v) ?? -1;
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  const sorted = [...groups].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.dv.localeCompare(b.dv) ||
      vIndex(a.variation) - vIndex(b.variation) ||
      a.variation - b.variation,
  );
  return sorted.flatMap((g) =>
    keys.map((key, i) => {
      const at = (f: number): number => g.acc.vals[i * FIELDS.length + f] ?? 0;
      const base: DailyRow = {
        date: g.date,
        variation_id: g.variation,
        metric_key: key.key,
        visitors: g.acc.visitors,
        converted: at(0),
        count: at(1),
        sum: roundHalfEven(at(2), 2),
        sum_sq: roundHalfEven(at(3), 2),
        sum_sq_visitor: roundHalfEven(at(4), 2),
        count_sq_visitor: at(5),
      };
      if (dimension === undefined) return base;
      const row: DimensionRow = { ...base, dimension, dimension_value: g.dv };
      return dimension === 'payment_type' ? { ...row, post_exposure: true } : row;
    }),
  );
}

/** Compute the daily rows (+ quality) for one experiment. Never stores anything. */
export async function computeDailyRows(
  run: QueryRunner,
  p: DailyRowsParams,
): Promise<DailyRowsResult> {
  assertRange(p.from, p.to);
  assertCurrency(p.reportCurrency);
  const keys = parseMetrics(p.metrics);
  assertDimensionKeys(p.dimension, keys);

  const cap = p.capOutliers ? await fetchCap(run, p) : undefined;
  const q = buildDailyRowsQuery({
    ...p,
    keys,
    ...(p.dimension === undefined ? {} : { dimension: p.dimension }),
    ...(cap === undefined ? {} : { cap }),
  });
  const [wide, quality] = await Promise.all([
    run<WideRow>(q.sql, q.params),
    fetchQualityBlock(run, p),
  ]);

  const top = p.dimension === undefined ? null : topValues(wide);
  const rows = rowsFrom(fold(wide, keys.length, top), keys, p.dimension, p.variationOrder);
  return p.dimension === undefined
    ? { dimension: null, rows: rows as DailyRow[], quality }
    : { dimension: p.dimension, rows: rows as DimensionRow[], quality };
}
