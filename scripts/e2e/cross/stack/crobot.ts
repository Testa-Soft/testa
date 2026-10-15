/**
 * crobot side of the live stack: the e2e app from `<crobot-dir>/docker/e2e/e2e.sh`
 * (compose project `crobot-e2e`: crb-e2e-web on :8188 + crb-e2e-worker,
 * MySQL `crobot_e2e`, crb-redis DB 11/12). The harness hands it the shared
 * secrets; the dev stack (crb-nginx, crb-php-fpm, dev DB) is never touched.
 */

import { existsSync } from 'node:fs';
import type { HarnessConfig } from '../lib/config.ts';
import { http, type HttpResponse } from '../lib/http.ts';
import { log } from '../lib/log.ts';
import { run, runOrThrow } from '../lib/shell.ts';

function scriptEnv(cfg: HarnessConfig): Record<string, string> {
  return {
    E2E_SERVICE_TOKEN: cfg.secrets.service,
    E2E_WEBHOOK_SECRET: cfg.secrets.webhook,
    E2E_CONFIG_TOKEN: cfg.secrets.config,
    E2E_COLLECTOR_URL: cfg.crobot.collectorUrlFromCrobot,
    CROBOT_E2E_PORT: String(cfg.crobot.port),
  };
}

function requireScript(cfg: HarnessConfig): void {
  if (!existsSync(cfg.crobot.script)) {
    throw new Error(
      `${cfg.crobot.script} not found — --crobot-dir must be a crobot checkout with docker/e2e (branch feat/analytics-v2-x0 or later)`,
    );
  }
}

export async function crobotUp(cfg: HarnessConfig): Promise<void> {
  requireScript(cfg);
  if (!cfg.args.crobotSetup) {
    log('crobot: --skip-crobot-setup, reusing the running e2e app');
    return;
  }
  log('crobot: e2e.sh up (env, crobot_e2e, containers, migrate:fresh, seed)…');
  await runOrThrow(['bash', cfg.crobot.script, 'up'], { env: scriptEnv(cfg), timeoutMs: 600_000 });
}

export async function crobotDown(cfg: HarnessConfig): Promise<void> {
  if (!existsSync(cfg.crobot.script)) return;
  await run(['bash', cfg.crobot.script, 'down'], { env: scriptEnv(cfg) });
}

/** Result line of `php artisan e2e:analytics …` (see E2EAnalyticsCommand.php). */
export interface ArtisanResult {
  readonly ok: boolean;
  readonly pending: boolean;
  readonly error?: string;
  readonly [key: string]: unknown;
}

export async function e2eArtisan(
  cfg: HarnessConfig,
  action: string,
  experiment?: number,
): Promise<ArtisanResult> {
  const cmd = [
    'docker',
    'exec',
    cfg.crobot.webContainer,
    'php',
    'artisan',
    'e2e:analytics',
    action,
  ];
  if (experiment !== undefined) cmd.push(`--experiment=${experiment}`);
  const res = await run(cmd, { timeoutMs: 180_000 });
  const line = res.stdout
    .trim()
    .split('\n')
    .reverse()
    .find((l) => l.startsWith('{'));
  if (line === undefined) {
    return {
      ok: false,
      pending: false,
      error: `no JSON from e2e:analytics ${action} (exit ${res.code}): ${(res.stdout + res.stderr).slice(-400)}`,
    };
  }
  return JSON.parse(line) as ArtisanResult;
}

/** Any artisan command in the e2e web container. */
export async function artisan(cfg: HarnessConfig, args: readonly string[]): Promise<string> {
  return runOrThrow(['docker', 'exec', cfg.crobot.webContainer, 'php', 'artisan', ...args], {
    timeoutMs: 180_000,
  });
}

let cachedToken: string | null = null;

/** crobot API call as the seeded user (`Authorization: <user token>`). */
export async function crobotApi(
  cfg: HarnessConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<HttpResponse> {
  if (cachedToken === null) {
    const res = await e2eArtisan(cfg, 'token');
    if (!res.ok || typeof res.token !== 'string')
      throw new Error(`could not mint a crobot API token: ${res.error}`);
    cachedToken = res.token;
  }
  return http({
    method,
    url: `${cfg.crobot.url}${path}`,
    headers: { authorization: cachedToken },
    ...(body !== undefined ? { body } : {}),
    timeoutMs: 30_000,
  });
}
