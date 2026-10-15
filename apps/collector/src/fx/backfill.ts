/**
 * FX backfill (PRD-006 §5.1, task 5.19): make every calendar day in a range
 * have USD-based rates, so "previous UTC day" always resolves. ECB (via
 * Frankfurter) publishes business days only: weekends and holidays carry the
 * previous business day's rates forward. Idempotent: only days with no rows
 * are written (and the table is a ReplacingMergeTree anyway).
 */
import { z } from 'zod';
import { config } from '../config.ts';
import { type FxRow, daysWithRates, upsertRates } from './store.ts';

const seriesSchema = z.object({
  rates: z.record(
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    z.record(z.string(), z.number().positive()),
  ),
});

export interface BackfillDeps {
  fetchFn?: typeof fetch;
  upsert?: (rows: readonly FxRow[]) => Promise<void>;
  existingDays?: (from: string, to: string) => Promise<Set<string>>;
  apiUrl?: string;
}

/** How far before `from` to look for the business day to carry into it. */
const LOOKBACK_DAYS = 10;
const DAY_MS = 86_400_000;

export const addDays = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** Fill missing days in [from, to]; returns the days written. */
export async function backfill(
  from: string,
  to: string,
  deps: BackfillDeps = {},
): Promise<string[]> {
  if (from > to) return [];
  const existing = await (deps.existingDays ?? daysWithRates)(from, to);
  const missing: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (!existing.has(d)) missing.push(d);
  if (missing.length === 0) return [];

  const fetchFn = deps.fetchFn ?? fetch;
  const api = (deps.apiUrl ?? config.fxApiUrl).replace(/\/+$/, '');
  const start = addDays(missing[0] as string, -LOOKBACK_DAYS);
  const end = missing[missing.length - 1] as string;
  const url = `${api}/${start}..${end}?from=USD`;
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`Frankfurter responded ${res.status} for ${url}`);
  const parsed = seriesSchema.safeParse(await res.json());
  if (!parsed.success) {
    throw new Error(`Frankfurter series invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
  }

  const business = Object.keys(parsed.data.rates).sort();
  const rows: FxRow[] = [];
  const written: string[] = [];
  for (const day of missing) {
    // Latest business day on or before `day` (carry forward over weekends / holidays).
    const source = business.filter((b) => b <= day).pop();
    const rates = source ? parsed.data.rates[source] : undefined;
    if (!rates) continue; // nothing published yet for this range
    for (const [to_ccy, rate] of Object.entries(rates))
      rows.push({ date: day, from_ccy: 'USD', to_ccy, rate });
    rows.push({ date: day, from_ccy: 'USD', to_ccy: 'USD', rate: 1 });
    written.push(day);
  }
  await (deps.upsert ?? upsertRates)(rows);
  return written;
}
