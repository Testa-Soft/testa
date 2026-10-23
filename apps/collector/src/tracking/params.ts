/**
 * Query-string validation for the tracking API (admin v2 CONTRACT "Tracking").
 * Pure; every failure is a {@link TrackingParamError} → 400 `{ error, field }`.
 */

export const MAX_EVENTS = 20;
export const DEFAULT_HITS_LIMIT = 50;
export const MAX_HITS_LIMIT = 200;
/** Look-back for `last_received_at`; also the oldest `since` hits accepts. */
export const LOOKBACK_MS = 30 * 86_400_000;
/** Window for `received_24h` and param coverage; also the default `since`. */
export const RECENT_MS = 86_400_000;

/** Same shape as `event:<name>` metric keys. */
const EVENT_NAME_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const ID_RE = /^[1-9]\d{0,17}$/;

export class TrackingParamError extends Error {
  readonly field: string;
  constructor(field: string) {
    super(`invalid_param: ${field}`);
    this.name = 'TrackingParamError';
    this.field = field;
  }
}

export function parseProjectId(raw: string | undefined): number {
  if (!raw || !ID_RE.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new TrackingParamError('projectId');
  }
  return Number(raw);
}

function parseEventName(raw: string | undefined, field: string): string {
  if (raw === undefined || !EVENT_NAME_RE.test(raw)) throw new TrackingParamError(field);
  return raw;
}

/** `events=a,b` → distinct names in request order (1..20). */
export function parseEventList(raw: string | undefined): string[] {
  if (!raw) throw new TrackingParamError('events');
  const names = [...new Set(raw.split(',').map((s) => s.trim()))];
  if (names.length > MAX_EVENTS) throw new TrackingParamError('events');
  return names.map((n) => parseEventName(n, 'events'));
}

export interface HitsParams {
  event: string;
  /** Epoch ms; hits received strictly after it. */
  sinceMs: number;
  limit: number;
}

/**
 * `event` required; `since` ISO-8601 (default now − 24 h, clamped to 30 days
 * back so a stale cursor can't scan the whole table); `limit` 1..200 (default 50).
 */
export function parseHitsParams(
  q: { event?: string | undefined; since?: string | undefined; limit?: string | undefined },
  nowMs: number,
): HitsParams {
  const event = parseEventName(q.event, 'event');
  let sinceMs = nowMs - RECENT_MS;
  if (q.since !== undefined && q.since !== '') {
    const parsed = Date.parse(q.since);
    if (Number.isNaN(parsed) || !/^\d{4}-\d{2}-\d{2}T/.test(q.since)) {
      throw new TrackingParamError('since');
    }
    sinceMs = Math.max(parsed, nowMs - LOOKBACK_MS);
  }
  let limit = DEFAULT_HITS_LIMIT;
  if (q.limit !== undefined && q.limit !== '') {
    limit = Number(q.limit);
    if (!/^\d+$/.test(q.limit) || limit < 1 || limit > MAX_HITS_LIMIT) {
      throw new TrackingParamError('limit');
    }
  }
  return { event, sinceMs, limit };
}

/** Epoch ms → ClickHouse `DateTime64(3, 'UTC')` literal value. */
export const chTime = (ms: number): string =>
  new Date(ms).toISOString().replace('T', ' ').replace('Z', '');

/** ClickHouse `YYYY-MM-DD hh:mm:ss.sss` (UTC) → ISO-8601. */
export const isoTime = (s: string): string => new Date(`${s.replace(' ', 'T')}Z`).toISOString();
