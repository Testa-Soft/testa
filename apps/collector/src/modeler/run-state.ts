/**
 * Per-experiment run state, Redis hash `modeler:run:{projectId}:{experimentId}` (PRD-006
 * §3.2). The sync API reads it to answer status / retry_after and to pick the
 * `metric_daily` run to serve (`last_ready_run_id`).
 */
import type { QualityBlock } from '@testa-platform/shared-types';
import type { Redis } from 'ioredis';

export type RunStatus = 'queued' | 'running' | 'ready' | 'failed';

export interface RunState {
  status: RunStatus | '';
  /** Run being computed (or last attempted). */
  run_id: string;
  last_ready_run_id: string;
  computed_at: string;
  data_through: string;
  queued_at: string;
  started_at: string;
  error: string;
  attempt: number;
  /** Of the last ready run. */
  quality: QualityBlock | null;
  from: string;
  to: string;
  report_currency: string;
  /** `updated_at` of the stopped subscription whose final run is stored. */
  final_for: string;
}

const EMPTY: RunState = {
  status: '',
  run_id: '',
  last_ready_run_id: '',
  computed_at: '',
  data_through: '',
  queued_at: '',
  started_at: '',
  error: '',
  attempt: 0,
  quality: null,
  from: '',
  to: '',
  report_currency: '',
  final_for: '',
};

const STATUSES: readonly RunStatus[] = ['queued', 'running', 'ready', 'failed'];

function parseQuality(raw: string | undefined): QualityBlock | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as QualityBlock;
  } catch {
    return null;
  }
}

export async function readRunState(redis: Redis, key: string): Promise<RunState> {
  const h = await redis.hgetall(key);
  const status = STATUSES.find((s) => s === h.status) ?? '';
  return {
    ...EMPTY,
    ...Object.fromEntries(
      Object.entries(h).filter(([k]) => k in EMPTY && k !== 'attempt' && k !== 'quality'),
    ),
    status,
    attempt: Number(h.attempt ?? 0) || 0,
    quality: parseQuality(h.quality),
  };
}

export async function writeRunState(
  redis: Redis,
  key: string,
  patch: Partial<RunState>,
): Promise<void> {
  const fields = Object.entries(patch).flatMap(([k, v]) => [
    k,
    k === 'quality' ? (v === null ? '' : JSON.stringify(v)) : String(v),
  ]);
  if (fields.length > 0) await redis.hset(key, ...fields);
}
