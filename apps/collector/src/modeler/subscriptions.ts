/**
 * `metric_subscriptions` access (PRD-006 §3.1): what crobot wants modeled per
 * experiment. ReplacingMergeTree on `updated_at`, read with FINAL. Experiment
 * ids (crobot identifiers) are unique per project only (R3): every lookup is by
 * `(project_id, experiment_id)`, the table's sorting key.
 */
import type { MetricKey } from '@testa-platform/shared-types';
import type { QueryRunner } from '../analytics/attribution.ts';

export type SubscriptionStatus = 'running' | 'stopped' | 'deleted';

export interface Subscription {
  projectId: number;
  experimentId: number;
  status: SubscriptionStatus;
  from: string;
  /** `null` while running. */
  to: string | null;
  reportCurrency: string;
  metrics: MetricKey[];
  /** `YYYY-MM-DD hh:mm:ss.sss` UTC. */
  updatedAt: string;
}

interface Row {
  project_id: string;
  experiment_id: string;
  status: string;
  from_s: string;
  to_s: string | null;
  report_currency: string;
  metrics: string[];
  updated_s: string;
}

// Aliases differ from column names on purpose (ClickHouse resolves aliases in WHERE).
const SELECT = `
  SELECT project_id, experiment_id, status, toString(from_date) AS from_s,
         if(isNull(to_date), NULL, toString(to_date)) AS to_s, report_currency, metrics,
         toString(updated_at) AS updated_s
  FROM metric_subscriptions FINAL`;

function fromRow(r: Row): Subscription {
  const status: SubscriptionStatus =
    r.status === 'stopped' || r.status === 'deleted' ? r.status : 'running';
  return {
    projectId: Number(r.project_id),
    experimentId: Number(r.experiment_id),
    status,
    from: r.from_s,
    to: r.to_s,
    reportCurrency: r.report_currency,
    metrics: r.metrics as MetricKey[],
    updatedAt: r.updated_s,
  };
}

export async function readSubscription(
  query: QueryRunner,
  projectId: number,
  experimentId: number,
): Promise<Subscription | null> {
  const rows = await query<Row>(
    `${SELECT}
     WHERE project_id = {project_id:UInt64} AND experiment_id = {experiment_id:UInt64}
     ORDER BY updated_at DESC LIMIT 1`,
    { project_id: projectId, experiment_id: experimentId },
  );
  const row = rows[0];
  return row ? fromRow(row) : null;
}

/** Subscriptions the scheduler looks at (running, and stopped awaiting a final run). */
export async function listSchedulable(query: QueryRunner): Promise<Subscription[]> {
  const rows = await query<Row>(`${SELECT} WHERE status IN ('running', 'stopped')`, {});
  return rows.map(fromRow);
}

export async function writeSubscription(
  insert: (table: string, rows: readonly object[]) => Promise<void>,
  sub: Subscription,
): Promise<void> {
  await insert('metric_subscriptions', [
    {
      project_id: sub.projectId,
      experiment_id: sub.experimentId,
      status: sub.status,
      from_date: sub.from,
      to_date: sub.to,
      report_currency: sub.reportCurrency,
      metrics: sub.metrics,
      updated_at: sub.updatedAt,
    },
  ]);
}

/** `Date` → `YYYY-MM-DD hh:mm:ss.sss` (DateTime64(3, 'UTC') JSON input). */
export const chDateTime = (d: Date): string => d.toISOString().replace('T', ' ').replace('Z', '');
