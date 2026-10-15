/**
 * Every port, name and secret of the live cross-repo topology, in one place.
 *
 * Isolation (PACKAGES.md "Shared local resources"):
 *   - ClickHouse  tp-clickhouse :8123, database `prd006_x0` only (dropped + re-migrated per run)
 *   - Redis       tp-redis :6380, DB index 13 (reserved for X0; collector tests flush 7–11, P5 uses 12) + stream key prefix `prd006:x0:`
 *   - Collector   bun on the host, :8091 (8090 belongs to the tp-collector container)
 *   - Edge        wrangler dev, :8792 (inspector :9339)
 *   - Crobot      compose project `crobot-e2e` (crb-e2e-web :8188, crb-e2e-worker), MySQL `crobot_e2e`
 *
 * Secrets are local throwaway values generated on first run and persisted in
 * `node_modules/.cache/e2e-cross/secrets.json` so `--keep-up` stacks and later runs agree.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CliArgs } from './args.ts';
import { harnessRoot } from './args.ts';

export interface Secrets {
  readonly ingest: string;
  readonly service: string;
  readonly webhook: string;
  readonly config: string;
}

export interface HarnessConfig {
  readonly args: CliArgs;
  readonly harnessRoot: string;
  readonly artifactsDir: string;
  readonly logsDir: string;
  readonly screenshotsDir: string;
  readonly secrets: Secrets;
  readonly collector: { readonly port: number; readonly url: string; readonly configDir: string };
  readonly edge: { readonly port: number; readonly inspectorPort: number; readonly url: string };
  readonly clickhouse: {
    readonly url: string;
    readonly database: string;
    readonly user: string;
    readonly password: string;
  };
  readonly redis: {
    readonly container: string;
    readonly url: string;
    readonly db: number;
    readonly streamKey: string;
    readonly consumerGroup: string;
    readonly keyPrefix: string;
  };
  readonly crobot: {
    readonly url: string;
    readonly port: number;
    readonly webContainer: string;
    readonly workerContainer: string;
    readonly database: string;
    /** The collector as seen from inside the crobot container. */
    readonly collectorUrlFromCrobot: string;
    readonly script: string;
  };
  /** Project / experiment ids shared with the crobot seeder (E2EAnalyticsSeeder). */
  readonly ids: {
    readonly projectId: number;
    readonly projectUuid: string;
    readonly f1: number;
    readonly f1Second: number;
    readonly f3: number;
    readonly v1Experiment: number;
  };
}

const COLLECTOR_PORT = 8091;
const EDGE_PORT = 8792;
const CROBOT_PORT = 8188;
const REDIS_DB = 13; // reserved for X0 (reset at stack start). Collector live tests share REDIS_TEST_DB (default 7) under per-file key prefixes and never FLUSHDB; P5 uses 12

function generateSecrets(): Secrets {
  const hex = (n: number): string => randomBytes(n).toString('hex');
  return {
    ingest: `x0-ingest-${hex(16)}`,
    service: `x0-svc-${hex(16)}`,
    webhook: `x0-whk-${hex(16)}`,
    config: `x0-cfg-${hex(16)}`,
  };
}

function loadSecrets(artifactsDir: string): Secrets {
  const file = join(artifactsDir, 'secrets.json');
  if (existsSync(file)) {
    return JSON.parse(readFileSync(file, 'utf8')) as Secrets;
  }
  const secrets = generateSecrets();
  writeFileSync(file, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  return secrets;
}

export function buildConfig(args: CliArgs): HarnessConfig {
  const artifactsDir = join(harnessRoot, 'node_modules', '.cache', 'e2e-cross');
  const logsDir = join(artifactsDir, 'logs');
  const screenshotsDir = join(artifactsDir, 'screenshots');
  for (const dir of [artifactsDir, logsDir, screenshotsDir, join(artifactsDir, 'configs')]) {
    mkdirSync(dir, { recursive: true });
  }
  return {
    args,
    harnessRoot,
    artifactsDir,
    logsDir,
    screenshotsDir,
    secrets: loadSecrets(artifactsDir),
    collector: {
      port: COLLECTOR_PORT,
      url: `http://localhost:${COLLECTOR_PORT}`,
      configDir: join(artifactsDir, 'configs'),
    },
    edge: { port: EDGE_PORT, inspectorPort: 9339, url: `http://localhost:${EDGE_PORT}` },
    clickhouse: {
      url: 'http://localhost:8123',
      database: 'prd006_x0',
      user: 'default',
      password: '',
    },
    redis: {
      container: 'tp-redis',
      url: `redis://localhost:6380/${REDIS_DB}`,
      db: REDIS_DB,
      streamKey: 'prd006:x0:events',
      consumerGroup: 'prd006-x0-writers',
      keyPrefix: 'prd006:x0:',
    },
    crobot: {
      url: `http://localhost:${CROBOT_PORT}`,
      port: CROBOT_PORT,
      webContainer: 'crb-e2e-web',
      workerContainer: 'crb-e2e-worker',
      database: 'crobot_e2e',
      collectorUrlFromCrobot: `http://host.docker.internal:${COLLECTOR_PORT}`,
      script: join(args.crobotDir, 'docker', 'e2e', 'e2e.sh'),
    },
    ids: {
      projectId: 42,
      projectUuid: 'e2e00000-0000-4000-8000-000000000042',
      f1: 1717,
      f1Second: 1802,
      f3: 1903,
      v1Experiment: 1900,
    },
  };
}
