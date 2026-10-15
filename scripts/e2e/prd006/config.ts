/**
 * Harness configuration for `pnpm prd006:validate` (task 5.14): CLI args,
 * ports, the dedicated ClickHouse database and Redis DB index, secrets, and
 * the fixture project / experiment ids (project ids ≥ 900000 so local dev
 * data never collides).
 */

import { join, resolve } from 'node:path';
import type { ChTarget } from '../cross/lib/clickhouse.ts';

export const REPO_ROOT = resolve(import.meta.dir, '../../..');
export const SAMPLES_DIR = join(REPO_ROOT, 'docs', 'reference', 'samples');
export const REPORT_PATH = join(REPO_ROOT, 'docs', 'prds', '006-validation-report.md');

export const FLOW_IDS = [
  'V1',
  'V2',
  'V3',
  'V4',
  'V5',
  'V6',
  'V7',
  'V8',
  'V9',
  'V10',
  'V11',
  'V12',
  'V13',
  'V14',
  'V15',
  'V16',
  'V17',
] as const;
export type FlowId = (typeof FLOW_IDS)[number];
export const FIXTURE_IDS = ['F1', 'F2', 'F3'] as const;
export type FixtureId = (typeof FIXTURE_IDS)[number];

/** Fixture → project / experiments (F1 keeps the doc's experiment ids). */
export const FIXTURES = {
  F1: { projectId: 900_042, experiments: [1717, 1802] },
  F2: { projectId: 900_043, experiments: [2001, 2002] },
  F3: { projectId: 900_044, experiments: [1903] },
} as const satisfies Record<FixtureId, { projectId: number; experiments: readonly number[] }>;

/** Flow-owned projects (not fixtures): V8 API contract (own rate-limit bucket) and V17 FX. */
export const CONTRACT = {
  projectId: 900_046,
  emptyV2: 1798,
  legacyV1: 1799,
  missing: 424_242,
} as const;
export const FX_FIXTURE = { projectId: 900_047, experiment: 1950 } as const;

export interface Args {
  readonly only: ReadonlySet<FlowId | FixtureId> | null;
  readonly keepUp: boolean;
  readonly dryRun: boolean;
  /** Stop a `--keep-up` stack (pids recorded by this harness) and exit. */
  readonly down: boolean;
  /** Skip `docker compose up` (CI uses job services). */
  readonly noCompose: boolean;
  readonly port: number;
  readonly reportPath: string;
}

export function parseArgs(argv: readonly string[]): Args {
  let only: Set<FlowId | FixtureId> | null = null;
  let port = 8090;
  let reportPath = REPORT_PATH;
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    const [name, inline] = a.includes('=') ? (a.split('=', 2) as [string, string]) : [a, undefined];
    const value = () => {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new Error(`${name} needs a value`);
      return v;
    };
    if (name === '--only') {
      const ids = value()
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
      const known = [...FLOW_IDS, ...FIXTURE_IDS] as readonly string[];
      const bad = ids.filter((id) => !known.includes(id));
      if (bad.length > 0) throw new Error(`--only: unknown ${bad.join(', ')}`);
      only = new Set(ids as (FlowId | FixtureId)[]);
    } else if (name === '--port') {
      port = Number(value());
      if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('--port: 1–65535');
    } else if (name === '--report') {
      reportPath = resolve(value());
    } else if (['--keep-up', '--dry-run', '--no-compose', '--down'].includes(name)) {
      flags.add(name);
    } else {
      throw new Error(`unknown argument ${a}`);
    }
  }
  return {
    only,
    keepUp: flags.has('--keep-up'),
    dryRun: flags.has('--dry-run'),
    down: flags.has('--down'),
    noCompose: flags.has('--no-compose') || process.env.CI === 'true',
    port,
    reportPath,
  };
}

export interface HarnessConfig {
  readonly args: Args;
  readonly collectorDir: string;
  readonly collectorUrl: string;
  readonly ch: ChTarget;
  readonly redisUrl: string;
  readonly secrets: {
    readonly ingest: string;
    readonly service: string;
    readonly config: string;
    readonly webhook: string;
  };
  readonly webhookPort: number;
  readonly artifactsDir: string;
}

/** ClickHouse databases the harness may drop and re-create. */
export const RESETTABLE_DATABASES = /^prd006_p[0-9]+$|^prd006_validate$/;

export function buildConfig(args: Args): HarnessConfig {
  const env = process.env;
  const artifactsDir = join(REPO_ROOT, 'node_modules', '.cache', 'prd006-validate');
  return {
    args,
    collectorDir: join(REPO_ROOT, 'apps', 'collector'),
    collectorUrl: `http://127.0.0.1:${args.port}`,
    ch: {
      url: env.PRD006_CLICKHOUSE_URL ?? 'http://localhost:8123',
      database: env.PRD006_CLICKHOUSE_DATABASE ?? 'prd006_validate',
      user: env.PRD006_CLICKHOUSE_USER ?? 'default',
      password: env.PRD006_CLICKHOUSE_PASSWORD ?? '',
    },
    redisUrl: env.PRD006_REDIS_URL ?? 'redis://localhost:6380/12',
    secrets: {
      ingest: 'prd006-ingest-secret-0123456789abcdef',
      service: 'prd006-service-token-0123456789',
      config: 'prd006-config-token-0123456789',
      webhook: 'prd006-webhook-secret-0123456789',
    },
    webhookPort: Number(env.PRD006_WEBHOOK_PORT ?? args.port + 100),
    artifactsDir,
  };
}

export function wants(cfg: HarnessConfig, id: FlowId | FixtureId): boolean {
  return cfg.args.only === null || cfg.args.only.has(id);
}
