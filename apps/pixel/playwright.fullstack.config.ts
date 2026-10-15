/**
 * PRD-006 full-stack run (tasks 5.5–5.7): the real pixel on a page → real edge
 * (`wrangler dev`) → collector → Redis → consumer → ClickHouse `prd006_p1`.
 *
 *   pnpm --filter @testa-platform/pixel test:e2e:fullstack
 *
 * Needs local ClickHouse (:8123) + Redis (:6380), bun and wrangler.
 */
import { defineConfig, devices } from '@playwright/test';
import { BROWSER_UA, PAGE_PORT } from './e2e/fullstack/stack.ts';

export default defineConfig({
  testDir: './e2e/fullstack',
  workers: 1,
  retries: 0,
  timeout: 120_000,
  reporter: 'list',
  globalSetup: './e2e/fullstack/global-setup.ts',
  globalTeardown: './e2e/fullstack/global-teardown.ts',
  use: {
    baseURL: `http://localhost:${PAGE_PORT}`,
    ...devices['Desktop Chrome'],
    userAgent: BROWSER_UA,
    locale: 'en-US',
  },
  webServer: {
    command: `npx http-server . -p ${PAGE_PORT} --silent -c-1`,
    url: `http://localhost:${PAGE_PORT}/e2e/fixtures/prd006-fullstack.html`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
