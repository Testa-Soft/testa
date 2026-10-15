/**
 * The modeler's own ClickHouse client: same server/database as the collector,
 * plus `max_execution_time` (PRD-006 §3.2) on every query.
 */
import { type ClickHouseClient, createClient } from '@clickhouse/client';
import type { QueryRunner } from '../analytics/attribution.ts';
import { config } from '../config.ts';

export interface ModelerClickHouse {
  query: QueryRunner;
  insert: (table: string, rows: readonly object[]) => Promise<void>;
  close: () => Promise<void>;
}

export function modelerClickHouse(
  maxExecutionSec = config.modeler.maxExecutionSec,
): ModelerClickHouse {
  const client: ClickHouseClient = createClient({
    url: config.clickhouse.url,
    username: config.clickhouse.user,
    password: config.clickhouse.password,
    database: config.clickhouse.database,
    request_timeout: (maxExecutionSec + 30) * 1000,
    clickhouse_settings: { max_execution_time: maxExecutionSec },
  });
  return {
    async query<T>(sql: string, params: Record<string, unknown>): Promise<T[]> {
      const rs = await client.query({ query: sql, query_params: params, format: 'JSONEachRow' });
      return (await rs.json()) as T[];
    },
    async insert(table, rows) {
      if (rows.length === 0) return;
      await client.insert({ table, values: rows, format: 'JSONEachRow' });
    },
    close: () => client.close(),
  };
}
