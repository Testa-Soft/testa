import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          // Secrets are set via `wrangler secret put` in real deploys; the
          // integration test needs deterministic values so the signed batch
          // and cookie domain are predictable.
          bindings: {
            INGEST_SHARED_SECRET: 'test-shared-secret-at-least-16-chars',
            INGEST_ORIGIN_URL: 'https://collector.test',
            COOKIE_FALLBACK_DOMAIN: '.testa.com',
            VISITOR_ID_SALT: 'test-salt',
          },
        },
      },
    },
    include: ['src/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
    // Coverage gate (task 2.8 acceptance): workerd can't be instrumented by the
    // v8 provider, so this needs `@vitest/coverage-istanbul` as a devDep plus:
    //   coverage: { provider: 'istanbul', include: ['src/**/*.ts'],
    //     exclude: ['src/**/__tests__/**', 'src/types.ts', 'src/data/**'],
    //     thresholds: { lines: 80, branches: 80 } }
    // Verified locally at 97.6% lines / 86% branches. Wiring it in is DEFERRED:
    // adding the dep regenerates pnpm-lock.yaml, which currently carries other
    // in-flight (uncommitted) workspace packages — committing that lock would
    // break CI's `--frozen-lockfile`. Land the gate once the lock is clean.
  },
});
