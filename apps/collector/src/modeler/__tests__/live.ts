/**
 * Live-ClickHouse test helpers for the modeler / sync API suites. Fixtures are
 * the reference samples (docs/reference/samples/{f1,demo}/raw), inserted
 * straight into `events` / `event_items` under a fresh random project_id.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@clickhouse/client';
import type { QueryRunner } from '../../analytics/attribution.ts';
import { config } from '../../config.ts';
import { insertRows, query } from '../../db/clickhouse.ts';
import { migrate } from '../../db/migrate.ts';

export const database = config.clickhouse.database;
export const live =
  Boolean(process.env.CLICKHOUSE_URL ?? process.env.RUN_LIVE_CH) && database !== 'default';

export const run: QueryRunner = (sql, params) => query(sql, params);

const SAMPLES = resolve(import.meta.dir, '../../../../../docs/reference/samples');

/** Oracle FX (generate.py `FX`): value of 1 unit in EUR. Stored as USD-based rates. */
const EUR_PER = { EUR: 1, USD: 0.9, GBP: 1.15 } as const;

export async function prepareDatabase(): Promise<void> {
  const admin = createClient({
    url: config.clickhouse.url,
    username: config.clickhouse.user,
    password: config.clickhouse.password,
  });
  try {
    await admin.command({ query: `CREATE DATABASE IF NOT EXISTS ${database}` });
  } finally {
    await admin.close();
  }
  await migrate();
}

export const randomProjectId = (): number => 700_000_000 + Math.floor(Math.random() * 99_000_000);

function readJsonl(path: string): Record<string, unknown>[] {
  const raw = path.endsWith('.gz')
    ? new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(readFileSync(path))))
    : readFileSync(path, 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

export function readGolden<T>(set: 'f1' | 'demo', file: string): T {
  return JSON.parse(readFileSync(`${SAMPLES}/${set}/modeled/${file}`, 'utf8')) as T;
}

const FIXTURE_EXPERIMENT = 1717;

export const randomExperimentId = (): number =>
  600_000_000 + Math.floor(Math.random() * 99_000_000);

/**
 * Insert a sample set's raw events + items under `projectId`, optionally
 * renaming experiment 1717 to `experimentId` (suites sharing a database use
 * their own ids so their scheduler passes don't touch each other).
 */
export async function seedSample(
  set: 'f1' | 'demo',
  projectId: number,
  experimentId: number = FIXTURE_EXPERIMENT,
): Promise<void> {
  const ext = set === 'demo' ? '.jsonl.gz' : '.jsonl';
  const remap = (id: unknown) => (id === FIXTURE_EXPERIMENT ? experimentId : id);
  const rewrite = (r: Record<string, unknown>) => ({
    ...r,
    project_id: projectId,
    ...(r.experiment_id === undefined ? {} : { experiment_id: remap(r.experiment_id) }),
    ...(Array.isArray(r.exp_ids) ? { exp_ids: r.exp_ids.map(remap) } : {}),
  });
  await insertRows('events', readJsonl(`${SAMPLES}/${set}/raw/events${ext}`).map(rewrite));
  await insertRows(
    'event_items',
    readJsonl(`${SAMPLES}/${set}/raw/event_items${ext}`).map(rewrite),
  );
}

const addDays = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** Seed the oracle's constant rates for [from − 1 day, to] (USD-based rows). */
export async function seedOracleFx(from: string, to: string): Promise<void> {
  const rows: object[] = [];
  for (let d = addDays(from, -1); d <= to; d = addDays(d, 1)) {
    for (const [ccy, eur] of Object.entries(EUR_PER)) {
      // rate(USD→ccy) = EUR per USD ÷ EUR per ccy
      rows.push({ date: d, from_ccy: 'USD', to_ccy: ccy, rate: EUR_PER.USD / eur });
    }
  }
  await insertRows('fx_rates_history', rows);
}

export async function seedFx(
  rows: { date: string; to_ccy: string; rate: number }[],
): Promise<void> {
  await insertRows(
    'fx_rates_history',
    rows.map((r) => ({ ...r, from_ccy: 'USD' })),
  );
}
