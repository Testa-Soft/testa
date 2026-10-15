/**
 * Response schemas of the live sync API, written from PRD-006 Part 3 / §4.5 /
 * §5.5 / §6.5 (not imported from the platform code under test). Every actual
 * response is parsed with these; a schema error is a contract failure.
 */

import { z } from './deps.ts';

export const SYNC_STATUSES = ['ready', 'queued', 'running', 'not_ready', 'failed'] as const;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const isoTs = z.string().min(10);
const status = z.enum(SYNC_STATUSES);

export const errorBody = z
  .object({ error: z.string(), field: z.unknown().optional() })
  .passthrough();

/** §3.1 response: `200 {status, next_run_at}`. */
export const subscriptionResponse = z
  .object({ status, next_run_at: isoTs.nullable() })
  .passthrough();

/** §2.3 / §3.4 additive daily row. */
export const dailyRow = z
  .object({
    date: isoDate,
    variation_id: z.number().int(),
    metric_key: z.string().min(1),
    visitors: z.number().int().nonnegative(),
    converted: z.number().int().nonnegative(),
    count: z.number().int().nonnegative(),
    sum: z.number(),
    sum_sq: z.number(),
    sum_sq_visitor: z.number(),
  })
  .passthrough();

export type DailyRow = z.infer<typeof dailyRow>;

/** §3.4 `GET …/daily-summary` (full response; `unchanged: true` has no rows). */
export const dailySummary = z
  .object({
    status,
    run_id: z.string().nullable(),
    computed_at: isoTs.nullable(),
    data_through: isoTs.nullable(),
    next_run_at: isoTs.nullable(),
    retry_after: z.number().nonnegative(),
    from: isoDate,
    to: isoDate.nullable(),
    report_currency: z.string().length(3),
    quality: z.object({
      multi_variation_visitors: z.number().int().nonnegative(),
      variation_mismatch_events: z.number().int().nonnegative(),
    }),
    rows: z.array(dailyRow),
  })
  .passthrough();

export type DailySummary = z.infer<typeof dailySummary>;

export const dailySummaryUnchanged = z
  .object({ status, run_id: z.string(), unchanged: z.literal(true), retry_after: z.number() })
  .passthrough();

/** §3.5 `POST …/queries` → 202 (or 200 when a fresh cached result exists). */
export const queryAccepted = z
  .object({
    query_id: z.string().regex(/^[0-9a-f]{64}$/, 'sha256 hex'),
    status,
    retry_after: z.number(),
  })
  .passthrough();

/** §3.5 `GET …/queries/{id}`: summary → rows (+dimension); other views → result. */
export const queryResult = z
  .object({
    query_id: z.string(),
    status,
    retry_after: z.number().optional(),
    rows: z
      .array(
        dailyRow.extend({
          dimension: z.string().nullable().optional(),
          dimension_value: z.string().nullable().optional(),
        }),
      )
      .optional(),
    result: z.unknown().optional(),
  })
  .passthrough();

const statsVariation = z
  .object({
    chance_to_beat_control: z.number().min(0).max(1).optional(),
    chance_to_be_best: z.number().min(0).max(1).optional(),
    lift: z.number().optional(),
    lift_ci: z.tuple([z.number(), z.number()]).optional(),
    expected_loss: z.number().optional(),
    insufficient_data: z.boolean().optional(),
  })
  .passthrough();

/** §4.5 `POST /api/v1/stats` → 200. */
export const statsResponse = z
  .object({ metrics: z.record(z.string(), z.record(z.string(), statsVariation)) })
  .passthrough();

/** First issue of a failed parse, readable. */
export function schemaIssues(error: {
  issues: readonly { path: readonly (string | number)[]; message: string }[];
}): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}
