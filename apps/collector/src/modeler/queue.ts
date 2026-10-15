/**
 * Modeler job queue (PRD-006 §3.2): Redis sorted set scored by priority, then
 * enqueue time. A job is in the queue at most once (re-enqueueing only ever
 * raises its priority). Retries wait in a second sorted set until due. A
 * per-experiment `SET NX` lock keeps two workers off the same experiment.
 */
import type { Redis } from 'ioredis';
import type { ModelerKeys } from './keys.ts';

/** Lower runs first: queries, then subscription changes / stops, then scheduled refreshes. */
export const PRIORITY = { query: 0, high: 1, scheduled: 2 } as const;
export type Priority = (typeof PRIORITY)[keyof typeof PRIORITY];

const PRIORITY_SPAN = 1e13; // > any ms timestamp until year 2286

export type Job =
  | { kind: 'refresh'; projectId: number; experimentId: number }
  | { kind: 'query'; queryId: string };

export function encodeJob(job: Job): string {
  return job.kind === 'refresh'
    ? `refresh:${job.projectId}:${job.experimentId}`
    : `query:${job.queryId}`;
}

export function decodeJob(member: string): Job | null {
  const [kind, a, b] = member.split(':');
  if (kind === 'query' && a) return { kind: 'query', queryId: a };
  if (kind === 'refresh' && a && b && /^\d+$/.test(a) && /^\d+$/.test(b)) {
    return { kind: 'refresh', projectId: Number(a), experimentId: Number(b) };
  }
  return null;
}

export const score = (priority: Priority, nowMs: number): number =>
  priority * PRIORITY_SPAN + nowMs;

/** Add (or raise the priority of) a job. Returns true when newly added. */
export async function enqueue(
  redis: Redis,
  keys: ModelerKeys,
  job: Job,
  priority: Priority,
  nowMs: number,
): Promise<boolean> {
  const member = encodeJob(job);
  // A job waiting for a retry is promoted to "ready now" by an explicit enqueue.
  await redis.zrem(keys.delayed, member);
  const added = await redis.zadd(keys.queue, 'LT', 'CH', score(priority, nowMs), member);
  return Number(added) > 0;
}

/** Park a job until `dueMs` (retry backoff); it is re-enqueued at `priority` (score = due × 10 + priority). */
export async function delay(
  redis: Redis,
  keys: ModelerKeys,
  job: Job,
  priority: Priority,
  dueMs: number,
): Promise<void> {
  await redis.zadd(keys.delayed, dueMs * 10 + priority, encodeJob(job));
}

/** Move due retries into the queue. */
export async function promoteDue(redis: Redis, keys: ModelerKeys, nowMs: number): Promise<number> {
  const due = await redis.zrangebyscore(keys.delayed, '-inf', nowMs * 10 + 9, 'WITHSCORES');
  let moved = 0;
  for (let i = 0; i < due.length; i += 2) {
    const member = due[i] as string;
    const priority = (Number(due[i + 1]) % 10) as Priority;
    if ((await redis.zrem(keys.delayed, member)) > 0) {
      await redis.zadd(keys.queue, 'LT', score(priority, nowMs), member);
      moved++;
    }
  }
  return moved;
}

/** Pop the next job (lowest score) or null. */
export async function dequeue(
  redis: Redis,
  keys: ModelerKeys,
): Promise<{ job: Job; priority: Priority } | null> {
  for (;;) {
    const popped = await redis.zpopmin(keys.queue);
    if (popped.length < 2) return null;
    const job = decodeJob(popped[0] as string);
    if (job) return { job, priority: Math.floor(Number(popped[1]) / PRIORITY_SPAN) as Priority };
    // Drop malformed members and keep going.
  }
}

/** 0-based position in the queue, or null when not queued. */
export async function position(redis: Redis, keys: ModelerKeys, job: Job): Promise<number | null> {
  const rank = await redis.zrank(keys.queue, encodeJob(job));
  return rank === null ? null : rank;
}

export async function isDelayed(redis: Redis, keys: ModelerKeys, job: Job): Promise<boolean> {
  return (await redis.zscore(keys.delayed, encodeJob(job))) !== null;
}

// ─── locks ──────────────────────────────────────────────────────────────────

const RELEASE_LUA = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

export async function acquireLock(
  redis: Redis,
  key: string,
  token: string,
  ttlSec: number,
): Promise<boolean> {
  return (await redis.set(key, token, 'EX', ttlSec, 'NX')) === 'OK';
}

/** Release only if we still hold it (compare-and-delete). */
export async function releaseLock(redis: Redis, key: string, token: string): Promise<void> {
  await redis.eval(RELEASE_LUA, 1, key, token);
}

// ─── retry_after ────────────────────────────────────────────────────────────

const DEFAULT_RUN_MS = 30_000;
const RETRY_MIN_SEC = 10;
const RETRY_MAX_SEC = 600;
const DURATION_SAMPLES = 20;

export async function recordDuration(redis: Redis, keys: ModelerKeys, ms: number): Promise<void> {
  await redis.lpush(keys.durations, String(Math.round(ms)));
  await redis.ltrim(keys.durations, 0, DURATION_SAMPLES - 1);
}

export async function averageRunMs(redis: Redis, keys: ModelerKeys): Promise<number> {
  const samples = (await redis.lrange(keys.durations, 0, -1)).map(Number).filter((n) => n > 0);
  return samples.length === 0
    ? DEFAULT_RUN_MS
    : samples.reduce((a, b) => a + b, 0) / samples.length;
}

export const clampRetry = (sec: number): number =>
  Math.min(RETRY_MAX_SEC, Math.max(RETRY_MIN_SEC, Math.ceil(sec)));

/**
 * Seconds a client should wait (PRD §3.3): queued → queue position × average
 * run time ÷ concurrency (+1 run); running → the rest of an average run.
 */
export async function retryAfter(
  redis: Redis,
  keys: ModelerKeys,
  job: Job,
  opts: { concurrency: number; runningSinceMs?: number; nowMs: number },
): Promise<number> {
  const avg = await averageRunMs(redis, keys);
  if (opts.runningSinceMs !== undefined) {
    return clampRetry((avg - (opts.nowMs - opts.runningSinceMs)) / 1000);
  }
  const pos = (await position(redis, keys, job)) ?? (await redis.zcard(keys.queue));
  return clampRetry(((Math.floor(pos / opts.concurrency) + 1) * avg) / 1000);
}
