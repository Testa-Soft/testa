/** In-memory stand-in for the two Redis commands the config store uses. */
import type { ConfigRedis } from '../redis-store.ts';

export interface FakeConfigRedis extends ConfigRedis {
  readonly data: ReadonlyMap<string, string>;
}

export function fakeConfigRedis(): FakeConfigRedis {
  const data = new Map<string, string>();
  return {
    data,
    async get(key: string) {
      return data.get(key) ?? null;
    },
    async mset(...pairs: string[]) {
      for (let i = 0; i + 1 < pairs.length; i += 2) {
        data.set(pairs[i] as string, pairs[i + 1] as string);
      }
      return 'OK';
    },
  };
}
