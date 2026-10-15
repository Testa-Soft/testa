/**
 * Shared constants for the PRD-006 full-stack Playwright run (task 5.5–5.7):
 * real pixel page → `wrangler dev` edge → collector → Redis → consumer →
 * ClickHouse. Ports / database are this package's own (not X0 / P5).
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const PAGE_PORT = Number(process.env.FULLSTACK_PAGE_PORT ?? 18990);
export const EDGE_PORT = Number(process.env.FULLSTACK_EDGE_PORT ?? 18991);
export const COLLECTOR_PORT = Number(process.env.FULLSTACK_COLLECTOR_PORT ?? 18992);
export const CH_URL = process.env.CLICKHOUSE_URL ?? 'http://localhost:8123';
export const CH_DB = process.env.FULLSTACK_CLICKHOUSE_DATABASE ?? 'prd006_p1';
export const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';

export const PIXEL_DIR = resolve(HERE, '../..');
export const COLLECTOR_DIR = resolve(PIXEL_DIR, '../collector');
export const EDGE_DIR = resolve(PIXEL_DIR, '../edge');
/** Child PIDs, written by global-setup, read by global-teardown. */
export const STATE_FILE = resolve(PIXEL_DIR, 'test-results/fullstack-stack.json');

/** A desktop Chrome UA: the edge tags Headless* UAs as bots (correctly). */
export const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

export async function chQuery<T>(sql: string): Promise<T[]> {
  const res = await fetch(`${CH_URL}/?database=${CH_DB}&default_format=JSONEachRow`, {
    method: 'POST',
    body: sql,
  });
  if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as T);
}
