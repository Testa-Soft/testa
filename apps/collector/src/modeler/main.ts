/**
 * Modeler process (PRD-006 §3.2): scheduler + worker pool that refreshes
 * subscribed experiments into `metric_daily` and runs on-demand queries.
 *
 *   pnpm --filter @testa-platform/collector dev:modeler           # long-running
 *   bun run src/modeler/main.ts --once   (or MODELER_ONCE=1)      # one synchronous pass
 *
 * `--once`: one scheduler tick, drain the queue (retries still waiting are left
 * for the next pass), wait for webhook deliveries, print a JSON summary, exit 0
 * (1 if any experiment ended `failed`).
 */
import IORedis from 'ioredis';
import { config } from '../config.ts';
import { createConfigStore } from '../config/select.ts';
import { modelerClickHouse } from './ch.ts';
import type { ModelerContext } from './context.ts';
import { modelerKeys } from './keys.ts';
import { readRunState } from './run-state.ts';
import { type ExperimentRef, tick } from './scheduler.ts';
import { createWebhookSender, noWebhooks } from './webhook.ts';
import { drain, runWorkers } from './worker.ts';

const log = (msg: string): void => console.log(`[modeler] ${msg}`);

export function createModelerContext(): ModelerContext & { close: () => Promise<void> } {
  const ch = modelerClickHouse();
  const redis = new IORedis(config.redis.url, { maxRetriesPerRequest: 3 });
  return {
    redis,
    keys: modelerKeys(config.modeler.keyPrefix),
    query: ch.query,
    insert: ch.insert,
    configStore: createConfigStore(config.configStore, () => redis),
    webhook: config.webhook.url ? createWebhookSender(config.webhook) : noWebhooks,
    settings: config.modeler,
    now: Date.now,
    log,
    close: async () => {
      await Promise.all([ch.close(), redis.quit().then(() => undefined)]);
    },
  };
}

export async function runOnce(
  ctx: ModelerContext,
): Promise<{ enqueued: ExperimentRef[]; processed: number; failed: ExperimentRef[] }> {
  const enqueued = await tick(ctx);
  const processed = await drain(ctx);
  await ctx.webhook.drain();
  const states = await Promise.all(
    enqueued.map((e) => readRunState(ctx.redis, ctx.keys.run(e.projectId, e.experimentId))),
  );
  const failed = enqueued.filter((_, i) => states[i]?.status === 'failed');
  return { enqueued, processed, failed };
}

async function runForever(ctx: ModelerContext): Promise<void> {
  const controller = new AbortController();
  const stop = () => {
    log('stopping…');
    controller.abort();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  const scheduleTick = async () => {
    try {
      const refs = await tick(ctx);
      if (refs.length > 0)
        log(`scheduled ${refs.map((e) => `${e.projectId}:${e.experimentId}`).join(', ')}`);
    } catch (err) {
      log(`scheduler error: ${(err as Error).message}`);
    }
  };
  await scheduleTick();
  const timer = setInterval(scheduleTick, config.modeler.intervalSec * 1000);
  log(`running: concurrency=${config.modeler.concurrency} interval=${config.modeler.intervalSec}s`);
  await runWorkers(ctx, controller.signal);
  clearInterval(timer);
  await ctx.webhook.drain();
}

async function main(): Promise<void> {
  const ctx = createModelerContext();
  try {
    if (config.modeler.once || process.argv.includes('--once')) {
      const summary = await runOnce(ctx);
      console.log(JSON.stringify({ modeler: 'once', ...summary }));
      if (summary.failed.length > 0) process.exitCode = 1;
    } else {
      await runForever(ctx);
    }
  } catch (err) {
    console.error('[modeler] fatal:', err);
    process.exitCode = 1;
  } finally {
    await ctx.close();
  }
}

if (import.meta.main) {
  void main();
}
