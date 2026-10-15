/**
 * Dependencies of the sync API: the same Redis keys / ClickHouse / config store
 * the modeler uses (built lazily from env), injectable for tests.
 */
import type { SyncStatus } from '@testa-platform/shared-types';
import { config } from '../config.ts';
import { fileConfigStore } from '../config/store.ts';
import { insertRows, query } from '../db/clickhouse.ts';
import type { ModelerContext } from '../modeler/context.ts';
import { modelerKeys } from '../modeler/keys.ts';
import { clampRetry, retryAfter } from '../modeler/queue.ts';
import type { RunState } from '../modeler/run-state.ts';
import { noWebhooks } from '../modeler/webhook.ts';
import { redis } from '../redis/client.ts';

export interface SyncContext extends ModelerContext {
  /** Scheduler interval, for `next_run_at` / idle `retry_after`. */
  intervalSec: number;
}

let defaultCtx: SyncContext | null = null;

export function defaultSyncContext(): SyncContext {
  if (!defaultCtx) {
    defaultCtx = {
      redis: redis(),
      keys: modelerKeys(config.modeler.keyPrefix),
      query: (sql, params) => query(sql, params),
      insert: insertRows,
      configStore: fileConfigStore(config.configDir),
      webhook: noWebhooks,
      settings: config.modeler,
      now: Date.now,
      log: (m) => console.warn(`[sync] ${m}`),
      intervalSec: config.modeler.intervalSec,
    };
  }
  return defaultCtx;
}

/** PRD §3.3 status of an experiment's daily summary from its run state. */
export function summaryStatus(state: RunState): SyncStatus {
  if (state.status === 'running') return 'running';
  if (state.status === 'failed') return 'failed';
  if (state.last_ready_run_id === '') return 'not_ready';
  return state.status === 'queued' ? 'queued' : 'ready';
}

export interface Timing {
  retryAfter: number;
  nextRunAt: string | null;
}

/** `retry_after` (s) and `next_run_at` (ISO) for a refresh job (PRD §3.3). */
export async function refreshTiming(
  ctx: SyncContext,
  projectId: number,
  experimentId: number,
  state: RunState,
  opts: { finalDone: boolean },
): Promise<Timing> {
  const nowMs = ctx.now();
  const job = { kind: 'refresh' as const, projectId, experimentId };
  const status = summaryStatus(state);
  if (status === 'running' || state.status === 'running') {
    const since = Date.parse(state.started_at);
    const secs = await retryAfter(ctx.redis, ctx.keys, job, {
      concurrency: ctx.settings.concurrency,
      nowMs,
      ...(Number.isNaN(since) ? {} : { runningSinceMs: since }),
    });
    return { retryAfter: secs, nextRunAt: new Date(nowMs).toISOString() };
  }
  if (state.status === 'queued' || status === 'not_ready') {
    const secs = await retryAfter(ctx.redis, ctx.keys, job, {
      concurrency: ctx.settings.concurrency,
      nowMs,
    });
    return { retryAfter: secs, nextRunAt: new Date(nowMs + secs * 1000).toISOString() };
  }
  if (opts.finalDone) return { retryAfter: clampRetry(ctx.intervalSec), nextRunAt: null };
  const last = Date.parse(state.computed_at);
  const next = Math.max(nowMs, (Number.isNaN(last) ? nowMs : last) + ctx.intervalSec * 1000);
  return { retryAfter: clampRetry(ctx.intervalSec), nextRunAt: new Date(next).toISOString() };
}
