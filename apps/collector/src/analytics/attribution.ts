/**
 * Shared attribution SQL (PRD-006 §2.1, §2.4–2.5, §5.4): "who was exposed" and
 * "which of their events count". The daily rows (modeler) and every query view
 * build on these, so attribution is defined exactly once.
 *
 * Rules:
 *  - Exposed set: visitors in `exposures` for E seen in exactly one variation,
 *    whose FIRST exposure falls in [from, to] (UTC dates). `date` = the
 *    first-exposure date; each visitor is in exactly one date row.
 *  - Attributed event: `has(exp_ids, E)`, `is_bot = 0`, visitor in the exposed
 *    set, `first_exposed_at ≤ client_ts < to + 1 day`. It carries the visitor's
 *    EXPOSURE variation (not the stamped one) and first-exposure `date`.
 *  - Purchases are deduped per (project_id, order_id) first, earliest wins.
 *
 * Builders are pure: they return SQL + ClickHouse query params (never inline
 * values). Dimension keys come from an allowlist; event names are bound params.
 * Mirrors the reference oracle `docs/reference/samples/generate.py` (`model`).
 */
import type { DimensionKey, QualityBlock } from '@testa-platform/shared-types';
import { SyncApiError } from './errors.ts';

export interface SqlQuery {
  sql: string;
  params: Record<string, unknown>;
}

export interface AttributionScope {
  projectId: number;
  experimentId: number;
  /** `YYYY-MM-DD` UTC, inclusive. */
  from: string;
  /** `YYYY-MM-DD` UTC, inclusive. */
  to: string;
}

export interface ExposedVisitorsParams extends AttributionScope {
  dims?: readonly DimensionKey[];
}

export interface AttributedEventsParams extends ExposedVisitorsParams {
  /** Event names to keep; omit for every event name. */
  eventNames?: readonly string[];
}

/** Dimensions snapshotted in `exposures` at first exposure (§3.6). */
const SNAPSHOT_DIMENSIONS = [
  'channel',
  'referrer_domain',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'country',
  'region',
  'city',
  'device_type',
  'os_name',
  'browser_name',
  'screen_resolution',
] as const satisfies readonly DimensionKey[];

type SnapshotDimension = (typeof SNAPSHOT_DIMENSIONS)[number];

/** Dimensions the exposed set can carry: the snapshots + derived `visitor_type`. */
export const EXPOSURE_DIMENSIONS: readonly DimensionKey[] = [
  ...SNAPSHOT_DIMENSIONS,
  'visitor_type',
];

/** Output column for a dimension in the exposed set / attributed events. */
export const dimColumn = (dim: DimensionKey): string => `dim_${dim}`;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_EVENT_NAME = 128;

const isSnapshot = (dim: DimensionKey): dim is SnapshotDimension =>
  (SNAPSHOT_DIMENSIONS as readonly string[]).includes(dim);

function assertScope(scope: AttributionScope): void {
  if (!Number.isSafeInteger(scope.projectId) || scope.projectId < 0) {
    throw new SyncApiError('experiment_not_found', 404, 'project_id');
  }
  if (!Number.isSafeInteger(scope.experimentId) || scope.experimentId < 0) {
    throw new SyncApiError('experiment_not_found', 404, 'experiment_id');
  }
  for (const field of ['from', 'to'] as const) {
    const value = scope[field];
    if (!DATE_RE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
      throw new SyncApiError('invalid_range', 400, field);
    }
  }
  if (scope.from > scope.to) throw new SyncApiError('invalid_range', 400, 'from');
}

function assertDims(dims: readonly DimensionKey[]): void {
  for (const dim of dims) {
    if (!EXPOSURE_DIMENSIONS.includes(dim)) throw new SyncApiError('unknown_dimension', 400, dim);
  }
}

function assertEventNames(names: readonly string[]): void {
  if (names.length === 0) throw new SyncApiError('unknown_metric', 400, 'event_names');
  for (const name of names) {
    if (name.length === 0 || name.length > MAX_EVENT_NAME) {
      throw new SyncApiError('unknown_metric', 400, 'event_names');
    }
  }
}

const scopeParams = (s: AttributionScope): Record<string, unknown> => ({
  project_id: s.projectId,
  experiment_id: s.experimentId,
  from: s.from,
  to: s.to,
});

const FROM_TS = `toDateTime64(toDate({from:String}), 3, 'UTC')`;
const END_TS = `toDateTime64(toDate({to:String}) + 1, 3, 'UTC')`;
/** Index of E in an event's parallel exp_* arrays (0 when absent → element defaults). */
const EXP_IDX = (alias: string): string => `indexOf(${alias}.exp_ids, {experiment_id:UInt64})`;

/**
 * The exposed set as a SELECT (no trailing semicolon) so callers can nest it.
 * Columns: visitor_id, variation_id, first_exposed_at, date, dim_<key>…
 *
 * visitor_type = `returning` when the visitor started a 2nd experiment session:
 * highest session_idx (exposures + attributed events) ≥ 2, or ≥ 2 distinct
 * session starts on their attributed events (the oracle's rule, which also
 * holds for data without session_idx).
 */
function exposedSelect(dims: readonly DimensionKey[]): string {
  const merges = dims
    .filter(isSnapshot)
    .map((d) => `argMinMerge(${d}) AS m_${d}`)
    .join(',\n        ');
  const outerDims = dims.map((d) =>
    d === 'visitor_type'
      ? `if(greatest(x.msi, s.ev_idx, s.ev_sessions) >= 2, 'returning', 'new') AS ${dimColumn(d)}`
      : `x.m_${d} AS ${dimColumn(d)}`,
  );
  const sessionsJoin = dims.includes('visitor_type')
    ? `
    LEFT JOIN (
      SELECT ev.visitor_id AS visitor_id,
             max(ev.exp_session_idx[${EXP_IDX('ev')}]) AS ev_idx,
             uniqExact(ev.exp_session_starts[${EXP_IDX('ev')}]) AS ev_sessions
      FROM events AS ev
      WHERE ev.project_id = {project_id:UInt64} AND ev.is_bot = 0
        AND has(ev.exp_ids, {experiment_id:UInt64}) AND ev.client_ts < ${END_TS}
      GROUP BY ev.visitor_id
    ) AS s ON s.visitor_id = x.visitor_id`
    : '';
  return `
    SELECT
      x.visitor_id AS visitor_id,
      x.var AS variation_id,
      x.fe AS first_exposed_at,
      toDate(x.fe) AS date${outerDims.map((d) => `,\n      ${d}`).join('')}
    FROM (
      SELECT
        visitor_id,
        min(first_exposed_at) AS fe,
        argMinMerge(variation_id) AS var,
        uniqExactMerge(variations_seen) AS seen,
        max(max_session_idx) AS msi${merges ? `,\n        ${merges}` : ''}
      FROM exposures
      WHERE project_id = {project_id:UInt64} AND experiment_id = {experiment_id:UInt64}
      GROUP BY visitor_id
    ) AS x${sessionsJoin}
    WHERE x.seen = 1 AND x.fe >= ${FROM_TS} AND x.fe < ${END_TS}`;
}

/** Exposed visitors (single variation, first exposure in range) with dimensions. */
export function buildExposedVisitors(p: ExposedVisitorsParams): SqlQuery {
  assertScope(p);
  const dims = p.dims ?? [];
  assertDims(dims);
  return { sql: `${exposedSelect(dims)}\n    ORDER BY visitor_id`, params: scopeParams(p) };
}

/** Earliest event per (project, order_id): the only purchase row that counts. */
const DEDUPED_PURCHASE_IDS = `
      SELECT argMin(d.event_id, d.client_ts)
      FROM events AS d
      WHERE d.project_id = {project_id:UInt64} AND d.event_name = 'purchase' AND d.order_id != ''
      GROUP BY d.order_id`;

/** Attributed events as a SELECT (no ORDER BY) so callers can aggregate over it. */
function attributedSelect(p: AttributedEventsParams): string {
  const dims = p.dims ?? [];
  const nameFilter = p.eventNames ? 'AND e.event_name IN {event_names:Array(String)}' : '';
  return `
    SELECT
      e.event_id AS event_id,
      e.event_name AS event_name,
      e.client_ts AS client_ts,
      e.visitor_id AS visitor_id,
      x.variation_id AS variation_id,
      x.date AS date,
      x.first_exposed_at AS first_exposed_at,
      e.exp_var_ids[${EXP_IDX('e')}] AS stamped_variation_id,
      e.exp_session_starts[${EXP_IDX('e')}] AS session_start,
      e.exp_session_idx[${EXP_IDX('e')}] AS session_idx,
      e.value_native AS value_native,
      e.currency AS currency,
      e.order_id AS order_id,
      if(e.event_name = 'purchase' AND e.purchase_type = '', 'initial', e.purchase_type) AS purchase_type,
      e.parent_order_id AS parent_order_id,
      e.cart_id AS cart_id,
      e.items_count AS items_count,
      e.goal_id AS goal_id,
      e.props AS props${dims.map((d) => `,\n      x.${dimColumn(d)} AS ${dimColumn(d)}`).join('')}
    FROM events AS e
    INNER JOIN (${exposedSelect(dims)}
    ) AS x ON e.visitor_id = x.visitor_id
    WHERE e.project_id = {project_id:UInt64}
      AND e.is_bot = 0
      AND has(e.exp_ids, {experiment_id:UInt64})
      ${nameFilter}
      AND e.client_ts >= x.first_exposed_at
      AND e.client_ts < ${END_TS}
      AND (e.event_name != 'purchase' OR e.order_id = '' OR e.event_id IN (${DEDUPED_PURCHASE_IDS}
      ))`;
}

/**
 * Events attributed to experiment E, each carrying the exposure `variation_id`,
 * first-exposure `date`, the stamped variation, E's session start / index, and
 * the requested `dim_<key>` columns. Purchases deduped (earliest per order_id);
 * `purchase_type` '' on a purchase reads as `initial` (§5.4).
 */
export function buildAttributedEvents(p: AttributedEventsParams): SqlQuery {
  assertScope(p);
  assertDims(p.dims ?? []);
  if (p.eventNames) assertEventNames(p.eventNames);
  const params = p.eventNames
    ? { ...scopeParams(p), event_names: [...p.eventNames] }
    : scopeParams(p);
  return { sql: `${attributedSelect(p)}\n    ORDER BY client_ts, event_id`, params };
}

/**
 * `quality` (§2.5): visitors seen in >1 variation whose first exposure is in
 * range, and attributed events (other than experiment_view) whose stamped
 * variation differs from the exposure variation. One row:
 * `{ multi_variation_visitors, variation_mismatch_events }`.
 */
export function buildQuality(scope: AttributionScope): SqlQuery {
  assertScope(scope);
  const sql = `
    SELECT
      (
        SELECT count()
        FROM (
          SELECT min(first_exposed_at) AS fe, uniqExactMerge(variations_seen) AS seen
          FROM exposures
          WHERE project_id = {project_id:UInt64} AND experiment_id = {experiment_id:UInt64}
          GROUP BY visitor_id
        )
        WHERE seen > 1 AND fe >= ${FROM_TS} AND fe < ${END_TS}
      ) AS multi_variation_visitors,
      (
        SELECT countIf(a.event_name != 'experiment_view' AND a.stamped_variation_id != a.variation_id)
        FROM (${attributedSelect(scope)}
        ) AS a
      ) AS variation_mismatch_events`;
  return { sql, params: scopeParams(scope) };
}

/** Runs a query and returns its rows (`db/clickhouse.ts#query` fits). */
export type QueryRunner = <T>(sql: string, params: Record<string, unknown>) => Promise<T[]>;

/** Executes `buildQuality` and normalises ClickHouse's UInt64-as-string output. */
export async function fetchQuality(
  run: QueryRunner,
  scope: AttributionScope,
): Promise<QualityBlock> {
  const q = buildQuality(scope);
  const [row] = await run<{
    multi_variation_visitors: string | number;
    variation_mismatch_events: string | number;
  }>(q.sql, q.params);
  return {
    multi_variation_visitors: Number(row?.multi_variation_visitors ?? 0),
    variation_mismatch_events: Number(row?.variation_mismatch_events ?? 0),
  };
}
