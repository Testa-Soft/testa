/**
 * Thin client for the platform's service APIs (sync API PRD-006 Part 3, stats
 * §4.5) over real HTTP with the service token. Polling helpers wait for
 * `status: ready` the way crobot does (`Retry-After`).
 */

import { http, type HttpResponse, waitFor } from '../../cross/lib/http.ts';
import type { HarnessConfig } from '../config.ts';

/** Ends a poll at once instead of retrying until the timeout (a run or query failed). */
export class FatalApiError extends Error {}
const rethrowFatal = (err: unknown): boolean => err instanceof FatalApiError;

export interface DailyRowLike {
  readonly date: string;
  readonly variation_id: number;
  readonly metric_key: string;
  readonly visitors: number;
  readonly converted: number;
  readonly count: number;
  readonly sum: number;
  readonly sum_sq: number;
  readonly sum_sq_visitor: number;
  readonly dimension?: string;
  readonly dimension_value?: string;
  readonly post_exposure?: boolean;
}

export interface SummaryBody {
  readonly status: string;
  readonly run_id: string | null;
  readonly rows: readonly DailyRowLike[];
  readonly quality?: Record<string, number>;
  readonly unchanged?: boolean;
  readonly [key: string]: unknown;
}

export interface Subscription {
  readonly projectId: number;
  readonly from: string;
  readonly to: string | null;
  readonly metrics: readonly string[];
  readonly status?: 'running' | 'stopped';
  readonly currency?: string;
}

export interface SyncApi {
  readonly url: string;
  call(method: string, path: string, body?: unknown, token?: string | null): Promise<HttpResponse>;
  subscribe(experimentId: number, sub: Subscription): Promise<HttpResponse>;
  summary(
    experimentId: number,
    sinceRunId?: string,
  ): Promise<{ res: HttpResponse; body: SummaryBody }>;
  /** Poll until `ready` (optionally with a run id other than `notRunId`). */
  waitReady(
    experimentId: number,
    opts?: { notRunId?: string | null; timeoutMs?: number },
  ): Promise<SummaryBody>;
  /** POST a query, poll its id until `ready`, return the full response body. */
  query(
    experimentId: number,
    body: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>>;
  stats(body: unknown, token?: string | null): Promise<HttpResponse>;
  /** Experiment path with `?project_id=` (+ params) for experiment-scoped GET / DELETE. */
  scoped(experimentId: number, rest: string, params?: Record<string, string>): string;
  remember(experimentId: number, projectId: number): void;
}

export function syncApi(cfg: HarnessConfig): SyncApi {
  const base = cfg.collectorUrl;
  const call: SyncApi['call'] = (method, path, body, token = cfg.secrets.service) =>
    http({
      method,
      url: `${base}${path}`,
      headers: token === null ? {} : { 'X-Service-Token': token },
      ...(body === undefined ? {} : { body }),
      timeoutMs: 60_000,
    });
  const exp = (id: number, rest: string) => `/api/v1/experiments/${id}${rest}`;
  // Experiment ids are unique per project only (R3): every experiment-scoped
  // GET / DELETE carries `?project_id=`, learned from the subscribe / query bodies.
  const projectOf = new Map<number, number>();
  const scoped = (id: number, rest: string, params: Record<string, string> = {}) => {
    const project = projectOf.get(id);
    const q = new URLSearchParams({
      ...(project === undefined ? {} : { project_id: String(project) }),
      ...params,
    });
    return exp(id, `${rest}${q.size > 0 ? `?${q}` : ''}`);
  };

  const api: SyncApi = {
    url: base,
    call,
    scoped,
    remember(id, projectId) {
      projectOf.set(id, projectId);
    },
    subscribe: (id, s) => {
      projectOf.set(id, s.projectId);
      return call('PUT', exp(id, '/subscription'), {
        project_id: s.projectId,
        status: s.status ?? 'running',
        from: s.from,
        to: s.to,
        report_currency: s.currency ?? 'EUR',
        metrics: s.metrics,
      });
    },
    async summary(id, sinceRunId) {
      const res = await call(
        'GET',
        scoped(id, '/daily-summary', sinceRunId ? { since_run_id: sinceRunId } : {}),
      );
      return { res, body: (res.json ?? {}) as SummaryBody };
    },
    async waitReady(id, opts = {}) {
      return waitFor(
        `experiment ${id} daily-summary ready`,
        async () => {
          const { res, body } = await api.summary(id);
          if (res.status !== 200)
            throw new Error(`GET daily-summary ${id} → ${res.status}: ${res.text.slice(0, 200)}`);
          if (body.status === 'failed') throw new FatalApiError(`experiment ${id} run failed`);
          const fresh = opts.notRunId === undefined || body.run_id !== opts.notRunId;
          return body.status === 'ready' && fresh ? body : undefined;
        },
        { timeoutMs: opts.timeoutMs ?? 180_000, intervalMs: 500, rethrow: rethrowFatal },
      );
    },
    async query(id, body, timeoutMs = 180_000) {
      if (typeof body.project_id === 'number') projectOf.set(id, body.project_id);
      const accepted = await call('POST', exp(id, '/queries'), body);
      if (accepted.status !== 202 && accepted.status !== 200) {
        throw new Error(`POST queries ${id} → ${accepted.status}: ${accepted.text.slice(0, 300)}`);
      }
      const first = accepted.json as Record<string, unknown>;
      if (accepted.status === 200 && first.status === 'ready') return first;
      const queryId = String(first.query_id);
      return waitFor(
        `query ${queryId.slice(0, 8)} ready`,
        async () => {
          const res = await call('GET', scoped(id, `/queries/${queryId}`));
          const b = res.json as Record<string, unknown> | null;
          if (res.status !== 200 || !b)
            throw new Error(`GET query → ${res.status}: ${res.text.slice(0, 200)}`);
          if (b.status === 'failed')
            throw new FatalApiError(`query failed: ${JSON.stringify(b).slice(0, 300)}`);
          return b.status === 'ready' ? b : undefined;
        },
        { timeoutMs, intervalMs: 300, rethrow: rethrowFatal },
      );
    },
    stats: (body, token = cfg.secrets.service) =>
      http({
        url: `${base}/api/v1/stats`,
        headers: token === null ? {} : { 'X-Service-Token': token },
        body,
        timeoutMs: 60_000,
      }),
  };
  return api;
}
