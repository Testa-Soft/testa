/**
 * On-demand query jobs (PRD-006 §3.5): `query_id` = sha256 of the canonical
 * body minus `refresh` (scoped to project + experiment), stored in Redis hash
 * `modeler:query:{id}`; the result lives `MODELER_QUERY_TTL_SEC` (1 h) and a
 * longer marker lets a read tell "expired" (410) from "never existed" (404).
 */
import { createHash } from 'node:crypto';
import type { QueryRequest } from '@testa-platform/shared-types';
import { requireV2Experiment } from '../analytics/guards.ts';
import { getView } from '../analytics/views.ts';
import { type ModelerContext, QUERY_KNOWN_TTL_SEC } from './context.ts';
import { PRIORITY, enqueue } from './queue.ts';
import { readSubscription } from './subscriptions.ts';
// Every view registers itself on import. The modeler process runs the query
// jobs, so it must load them all, not only the API server (src/index.ts).
import '../distributions/view.ts';
import '../health/view.ts';
import '../products/view.ts';
import './summary-view.ts';
import { configForProject } from './project-config.ts';

export type QueryStatus = 'queued' | 'running' | 'ready' | 'failed';

export interface StoredQuery {
  queryId: string;
  experimentId: number;
  projectId: number;
  status: QueryStatus;
  request: QueryRequest;
  /** View result (SummaryResult / ProductsResult / …) once ready. */
  result: unknown;
  computedAt: string;
  queuedAt: string;
  startedAt: string;
  error: string;
  attempt: number;
}

/** Stable JSON: object keys sorted recursively. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function queryId(experimentId: number, request: QueryRequest): string {
  const { refresh: _refresh, ...rest } = request;
  return createHash('sha256')
    .update(canonicalJson({ experiment_id: experimentId, ...rest }))
    .digest('hex');
}

const STATUSES: readonly QueryStatus[] = ['queued', 'running', 'ready', 'failed'];

function parseJson(raw: string | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function readQuery(
  ctx: ModelerContext,
  id: string,
): Promise<StoredQuery | 'expired' | null> {
  const h = await ctx.redis.hgetall(ctx.keys.query(id));
  if (!h.request) {
    return (await ctx.redis.exists(ctx.keys.queryKnown(id))) ? 'expired' : null;
  }
  return {
    queryId: id,
    experimentId: Number(h.experiment_id),
    projectId: Number(h.project_id),
    status: STATUSES.find((s) => s === h.status) ?? 'queued',
    request: parseJson(h.request) as QueryRequest,
    result: parseJson(h.result),
    computedAt: h.computed_at ?? '',
    queuedAt: h.queued_at ?? '',
    startedAt: h.started_at ?? '',
    error: h.error ?? '',
    attempt: Number(h.attempt ?? 0) || 0,
  };
}

/** Store a (re)submitted query and enqueue it at query priority. */
export async function submitQuery(
  ctx: ModelerContext,
  experimentId: number,
  request: QueryRequest,
): Promise<string> {
  const id = queryId(experimentId, request);
  const key = ctx.keys.query(id);
  const nowMs = ctx.now();
  await ctx.redis
    .multi()
    .del(key)
    .hset(key, {
      experiment_id: String(experimentId),
      project_id: String(request.project_id),
      status: 'queued',
      request: JSON.stringify(request),
      queued_at: new Date(nowMs).toISOString(),
      attempt: '0',
    })
    // A pending job keeps its hash until it runs (and at most a day).
    .expire(key, 86_400)
    .set(ctx.keys.queryKnown(id), String(experimentId), 'EX', QUERY_KNOWN_TTL_SEC)
    .zadd(ctx.keys.queryPending(request.project_id), nowMs, id)
    .exec();
  await enqueue(ctx.redis, ctx.keys, { kind: 'query', queryId: id }, PRIORITY.query, nowMs);
  return id;
}

/** Run a queued query's view and store its result. Throws on failure (worker retries). */
export async function runQueryJob(ctx: ModelerContext, id: string): Promise<'ready' | 'skipped'> {
  const stored = await readQuery(ctx, id);
  if (stored === null || stored === 'expired') return 'skipped';
  const key = ctx.keys.query(id);
  const startedMs = ctx.now();
  await ctx.redis.hset(key, { status: 'running', started_at: new Date(startedMs).toISOString() });

  const { request } = stored;
  const config = await configForProject(ctx.configStore, request.project_id);
  const experiment = requireV2Experiment(config, stored.experimentId);
  const sub = await readSubscription(ctx.query, request.project_id, stored.experimentId);
  const view = getView(request.view);
  const { view: _v, project_id: _p, refresh: _r, ...rawParams } = request;
  const params = view.validate(rawParams);
  const result = await (view.run as (c: unknown, p: unknown) => Promise<unknown>)(
    {
      projectId: request.project_id,
      experimentId: stored.experimentId,
      experiment,
      reportCurrency: request.report_currency ?? sub?.reportCurrency ?? 'EUR',
      query: ctx.query,
    },
    params,
  );

  const computedAt = new Date(ctx.now()).toISOString();
  await ctx.redis
    .multi()
    .hset(key, {
      status: 'ready',
      result: JSON.stringify(result),
      computed_at: computedAt,
      error: '',
    })
    .expire(key, ctx.settings.queryTtlSec)
    .zrem(ctx.keys.queryPending(request.project_id), id)
    .exec();
  ctx.webhook.send({
    event: 'query-ready',
    project_id: request.project_id,
    experiment_id: stored.experimentId,
    query_id: id,
    computed_at: computedAt,
  });
  return 'ready';
}

/** Mark a query failed for good (after retries); the result key keeps the error 1 h. */
export async function failQuery(ctx: ModelerContext, id: string, error: string): Promise<void> {
  const stored = await readQuery(ctx, id);
  const key = ctx.keys.query(id);
  const multi = ctx.redis
    .multi()
    .hset(key, { status: 'failed', error })
    .expire(key, ctx.settings.queryTtlSec);
  if (stored && stored !== 'expired') multi.zrem(ctx.keys.queryPending(stored.projectId), id);
  await multi.exec();
}
