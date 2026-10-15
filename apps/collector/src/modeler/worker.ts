/**
 * Worker loop (PRD-006 §3.2): pop the next job, hold the experiment lock for a
 * refresh, run it, and on failure retry with backoff (MODELER_RETRY_DELAYS_SEC)
 * before marking it `failed`. The last good run stays readable throughout.
 */
import { randomUUID } from 'node:crypto';
import type { ModelerContext } from './context.ts';
import { failQuery, runQueryJob } from './query-jobs.ts';
import {
  type Job,
  type Priority,
  acquireLock,
  delay,
  dequeue,
  promoteDue,
  releaseLock,
} from './queue.ts';
import { runRefresh } from './refresh.ts';
import { readRunState, writeRunState } from './run-state.ts';

/** When another worker holds the experiment lock, look again after this. */
const LOCKED_RETRY_MS = 5_000;

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function retryOrFail(
  ctx: ModelerContext,
  job: Job,
  priority: Priority,
  attempt: number,
  err: unknown,
): Promise<void> {
  const error = message(err);
  const delaySec = ctx.settings.retryDelaysSec[attempt - 1];
  const willRetry = delaySec !== undefined;
  ctx.log(
    `${job.kind} ${'experimentId' in job ? job.experimentId : job.queryId} attempt ${attempt} failed: ${error}${willRetry ? ` (retry in ${delaySec}s)` : ''}`,
  );
  if (job.kind === 'refresh') {
    await writeRunState(ctx.redis, ctx.keys.run(job.experimentId), {
      status: willRetry ? 'queued' : 'failed',
      error,
      attempt: willRetry ? attempt : 0,
    });
  } else if (!willRetry) {
    await failQuery(ctx, job.queryId, error);
  } else {
    await ctx.redis.hset(ctx.keys.query(job.queryId), { status: 'queued', error });
  }
  if (willRetry) await delay(ctx.redis, ctx.keys, job, priority, ctx.now() + delaySec * 1000);
}

async function processRefresh(
  ctx: ModelerContext,
  job: Extract<Job, { kind: 'refresh' }>,
  priority: Priority,
): Promise<void> {
  const lockKey = ctx.keys.lock(job.experimentId);
  const token = randomUUID();
  if (!(await acquireLock(ctx.redis, lockKey, token, ctx.settings.lockTtlSec))) {
    await delay(ctx.redis, ctx.keys, job, priority, ctx.now() + LOCKED_RETRY_MS);
    return;
  }
  const runKey = ctx.keys.run(job.experimentId);
  const attempt = (await readRunState(ctx.redis, runKey)).attempt + 1;
  await writeRunState(ctx.redis, runKey, { attempt });
  try {
    await runRefresh(ctx, job.projectId, job.experimentId);
  } catch (err) {
    await retryOrFail(ctx, job, priority, attempt, err);
  } finally {
    await releaseLock(ctx.redis, lockKey, token);
  }
}

async function processQuery(
  ctx: ModelerContext,
  job: Extract<Job, { kind: 'query' }>,
  priority: Priority,
): Promise<void> {
  const attempt = await ctx.redis.hincrby(ctx.keys.query(job.queryId), 'attempt', 1);
  try {
    await runQueryJob(ctx, job.queryId);
  } catch (err) {
    await retryOrFail(ctx, job, priority, attempt, err);
  }
}

/** Process at most one job. Returns false when the queue was empty. */
export async function processNext(ctx: ModelerContext): Promise<boolean> {
  await promoteDue(ctx.redis, ctx.keys, ctx.now());
  const next = await dequeue(ctx.redis, ctx.keys);
  if (!next) return false;
  if (next.job.kind === 'refresh') await processRefresh(ctx, next.job, next.priority);
  else await processQuery(ctx, next.job, next.priority);
  return true;
}

/** Drain the queue with `concurrency` parallel loops; returns how many jobs ran. */
export async function drain(ctx: ModelerContext): Promise<number> {
  let processed = 0;
  const loop = async (): Promise<void> => {
    while (await processNext(ctx)) processed++;
  };
  await Promise.all(Array.from({ length: ctx.settings.concurrency }, loop));
  return processed;
}

/** Run worker loops until `signal` aborts. */
export async function runWorkers(ctx: ModelerContext, signal: AbortSignal): Promise<void> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const loop = async (): Promise<void> => {
    while (!signal.aborted) {
      try {
        if (!(await processNext(ctx))) await sleep(ctx.settings.pollMs);
      } catch (err) {
        ctx.log(`worker error: ${message(err)}`);
        await sleep(ctx.settings.pollMs);
      }
    }
  };
  await Promise.all(Array.from({ length: ctx.settings.concurrency }, loop));
}
