/** Request validation for the sync API (PRD-006 §5.5 400 codes). */
import type { MetricKey } from '@testa-platform/shared-types';
import { SyncApiError } from '../analytics/errors.ts';
import { assertCurrency, assertRange } from '../modeler/daily-rows.ts';
import { parseMetrics } from '../modeler/metric-keys.ts';

const ID_RE = /^[1-9]\d{0,17}$/;

/** Path / body ids: positive safe integers; anything else is `notFound`. */
export function parseId(raw: unknown, notFound: SyncApiError): number {
  const s = typeof raw === 'number' ? String(raw) : raw;
  if (typeof s !== 'string' || !ID_RE.test(s) || !Number.isSafeInteger(Number(s))) throw notFound;
  return Number(s);
}

/**
 * R3: the numeric `project_id` every experiment-scoped call carries (body or
 * `?project_id=`). Missing / not a positive integer → 400 `invalid_body`.
 */
export function parseProjectId(raw: unknown): number {
  return parseId(raw, new SyncApiError('invalid_body', 400, 'project_id'));
}

export function asObject(raw: unknown, onError: SyncApiError): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw onError;
  return raw as Record<string, unknown>;
}

export interface SubscriptionBody {
  projectId: number;
  status: 'running' | 'stopped';
  from: string;
  to: string | null;
  reportCurrency: string;
  metrics: MetricKey[];
}

/** `PUT …/subscription` body (PRD §3.1). */
export function validateSubscription(raw: unknown): SubscriptionBody {
  const body = asObject(raw, new SyncApiError('invalid_status', 400, 'body'));
  const projectId = parseProjectId(body.project_id);
  if (body.status !== 'running' && body.status !== 'stopped') {
    throw new SyncApiError('invalid_status', 400, 'status');
  }
  const from = typeof body.from === 'string' ? body.from : '';
  if (body.to !== null && body.to !== undefined && typeof body.to !== 'string') {
    throw new SyncApiError('invalid_range', 400, 'to');
  }
  const to = typeof body.to === 'string' ? body.to : null;
  assertRange(from, to ?? from);
  return {
    projectId,
    status: body.status,
    from,
    to,
    reportCurrency: assertCurrency(body.report_currency),
    metrics: parseMetrics(body.metrics).map((k) => k.key),
  };
}
