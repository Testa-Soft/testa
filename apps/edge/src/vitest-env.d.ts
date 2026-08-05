/**
 * Types for the `cloudflare:test` module used by the vitest-pool-workers
 * integration test. `ProvidedEnv` is what `env` resolves to — our worker `Env`
 * plus the miniflare test bindings declared in `vitest.config.ts`.
 */
import type { Env } from './types.ts';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}
