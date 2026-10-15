/**
 * Redis via `redis-cli` inside the tp-redis container (no client dependency).
 * Every call is pinned to the harness DB index.
 */

import { run, runOrThrow } from './shell.ts';

export interface RedisTarget {
  readonly container: string;
  readonly db: number;
}

export async function redisCli(target: RedisTarget, args: readonly string[]): Promise<string> {
  const out = await runOrThrow([
    'docker',
    'exec',
    target.container,
    'redis-cli',
    '-n',
    String(target.db),
    ...args,
  ]);
  return out.trim();
}

export async function redisPing(target: RedisTarget): Promise<boolean> {
  const res = await run(['docker', 'exec', target.container, 'redis-cli', 'ping']);
  return res.code === 0 && res.stdout.trim() === 'PONG';
}

/** Empty the harness DB index (reserved for X0; nothing else lives there). */
export async function redisResetDb(target: RedisTarget): Promise<void> {
  await redisCli(target, ['FLUSHDB']);
}
