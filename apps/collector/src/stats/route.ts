/**
 * `POST /api/v1/stats` body handling (PRD-006 §4.5, task 5.11): validate the
 * summed inputs crobot sends, run {@link computeStats} per metric, shape the
 * response. Stateless: no ClickHouse, no Redis.
 *
 * Seeding: the endpoint has no experiment or group, so each metric's seedKey
 * is `|${key}|` (empty experimentId and groupKey, see `StatsRequest.seedKey`).
 * Identical bodies give byte-identical responses.
 */
import { z } from 'zod';
import { type VariationStats, computeStats } from './index.ts';

export const FULL_DRAWS = 100_000;
export const SEGMENT_DRAWS = 10_000;
export const MAX_METRICS = 50;
export const MAX_VARIATIONS = 10;
/** Far above 50 × 10 inputs; enforced in bytes by the router's bodyLimit. */
export const MAX_BODY_BYTES = 256 * 1024;

/**
 * Stats-only error codes, same `{ error, field }` shape as the sync API's
 * `SyncError`. Local because shared-types is frozen for P3; P6 may promote them.
 */
export type StatsErrorCode = 'invalid_body' | 'too_large';

export interface StatsError {
  error: StatsErrorCode;
  field?: string;
}

const variationSchema = z.object({
  variation: z.number().int(),
  n: z.number().int().nonnegative(),
  x: z.number().int().nonnegative().optional(),
  sum: z.number().finite().optional(),
  sumSq: z.number().finite().nonnegative().optional(),
});

const metricSchema = z.object({
  key: z.string().min(1).max(200),
  model: z.enum(['beta', 'normal']),
  direction: z.enum(['higher', 'lower']).optional(),
  variations: z.array(variationSchema).min(2),
});

const bodySchema = z.object({
  control: z.number().int(),
  confidence: z.number().gt(0).lt(1).optional(),
  draws: z.number().int().min(1).max(FULL_DRAWS).optional(),
  metrics: z.array(metricSchema).min(1),
  segment: z.boolean().optional(),
});

export type StatsBody = z.infer<typeof bodySchema>;

export interface StatsResponse {
  metrics: Record<string, Record<string, VariationStats>>;
}

export type ParseResult = { ok: true; body: StatsBody } | { ok: false; error: StatsError };

const fail = (error: StatsErrorCode, field?: string): ParseResult => ({
  ok: false,
  error: field === undefined ? { error } : { error, field },
});

/** Raw request text → a validated body, or the 400 to send. */
export function parseStatsBody(raw: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return fail('invalid_body');
  }
  const tooLarge = sizeError(json);
  if (tooLarge) return tooLarge;
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path ?? [];
    return fail('invalid_body', formatPath(path));
  }
  return crossFieldError(parsed.data) ?? { ok: true, body: parsed.data };
}

/** 50 metrics × 10 variations per call (§5.11), checked before the schema. */
function sizeError(json: unknown): ParseResult | undefined {
  const metrics = (json as { metrics?: unknown } | null)?.metrics;
  if (!Array.isArray(metrics)) return undefined;
  if (metrics.length > MAX_METRICS) return fail('too_large', 'metrics');
  const wide = metrics.findIndex(
    (m) =>
      Array.isArray((m as { variations?: unknown })?.variations) &&
      (m as { variations: unknown[] }).variations.length > MAX_VARIATIONS,
  );
  return wide < 0 ? undefined : fail('too_large', `metrics[${wide}].variations`);
}

/** Rules the schema can't express: unique keys and ids, control present, model inputs. */
function crossFieldError(body: StatsBody): ParseResult | undefined {
  const keys = new Set<string>();
  for (const [i, m] of body.metrics.entries()) {
    const at = `metrics[${i}]`;
    if (keys.has(m.key)) return fail('invalid_body', `${at}.key`);
    keys.add(m.key);
    const ids = new Set(m.variations.map((v) => v.variation));
    if (ids.size !== m.variations.length) return fail('invalid_body', `${at}.variations`);
    if (!ids.has(body.control)) return fail('invalid_body', 'control');
    for (const [j, v] of m.variations.entries()) {
      const missing = missingInput(m.model, v);
      if (missing) return fail('invalid_body', `${at}.variations[${j}].${missing}`);
    }
  }
  return undefined;
}

function missingInput(
  model: StatsBody['metrics'][number]['model'],
  v: z.infer<typeof variationSchema>,
): string | undefined {
  if (model === 'beta') return v.x === undefined || v.x > v.n ? 'x' : undefined;
  if (v.sum === undefined) return 'sum';
  return v.sumSq === undefined ? 'sumSq' : undefined;
}

function formatPath(path: (string | number)[]): string {
  return path.reduce<string>(
    (acc, p) => (typeof p === 'number' ? `${acc}[${p}]` : acc === '' ? p : `${acc}.${p}`),
    '',
  );
}

/** Validated body → response. Pure and deterministic. */
export function runStats(body: StatsBody): StatsResponse {
  const draws = body.draws ?? (body.segment ? SEGMENT_DRAWS : FULL_DRAWS);
  const entries = body.metrics.map((m) => {
    const stats = computeStats({
      model: m.model,
      control: body.control,
      draws,
      seedKey: `|${m.key}|`,
      ...(body.confidence === undefined ? {} : { confidence: body.confidence }),
      ...(m.direction === undefined ? {} : { direction: m.direction }),
      variations: m.variations.map(toInput),
    });
    const perVariation = Object.fromEntries([...stats].map(([id, s]) => [String(id), s] as const));
    return [m.key, perVariation] as const;
  });
  return { metrics: Object.fromEntries(entries) };
}

/** Drop absent optionals (exactOptionalPropertyTypes). */
function toInput(v: z.infer<typeof variationSchema>) {
  return {
    variation: v.variation,
    n: v.n,
    ...(v.x === undefined ? {} : { x: v.x }),
    ...(v.sum === undefined ? {} : { sum: v.sum }),
    ...(v.sumSq === undefined ? {} : { sumSq: v.sumSq }),
  };
}
