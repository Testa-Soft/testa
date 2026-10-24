/**
 * Money conversion in ClickHouse (PRD-006 §5.1, task 5.19): each order converts
 * to the reporting currency at the PREVIOUS UTC day's rate, falling back to the
 * last known rate on or before that day. `fx_rates_history` holds USD-based
 * rates (USD → X), so  amount_R = amount_C / rate(USD→C) × rate(USD→R).
 *
 * This is the shared `fxSqlExpr`: a previous-day + last-known lookup needs an
 * ASOF JOIN, so instead of a scalar expression it wraps a SELECT that has
 * `currency` and `client_ts` columns and adds:
 *   fx   multiplier into {report_currency:String} — 1 for the same currency,
 *        0 when the event has no currency or no rate is known (the value then
 *        drops out of sums);
 *   fx_unconvertible  1 when the event has a currency but no usable rate.
 * The backfill (backfill.ts) keeps every calendar day filled, so the ASOF
 * fallback only matters for days not yet synced.
 */

const USD_RATES = `(SELECT to_ccy, date, rate FROM fx_rates_history FINAL WHERE from_ccy = 'USD' AND rate > 0)`;

export const REPORT_CURRENCY_PARAM = 'report_currency';

export function withFx(innerSelect: string): string {
  return `
    SELECT
      b.*,
      multiIf(
        b.currency = '', 0,
        b.currency = b.fx_report, 1,
        fc.rate = 0 OR fr.rate = 0, 0,
        fr.rate / fc.rate
      ) AS fx,
      toUInt8(b.currency != '' AND b.currency != b.fx_report AND (fc.rate = 0 OR fr.rate = 0)) AS fx_unconvertible
    FROM (
      SELECT i.*, toDate(i.client_ts) - 1 AS fx_date, {${REPORT_CURRENCY_PARAM}:String} AS fx_report
      FROM (${innerSelect}) AS i
    ) AS b
    ASOF LEFT JOIN ${USD_RATES} AS fc ON fc.to_ccy = b.currency AND b.fx_date >= fc.date
    ASOF LEFT JOIN ${USD_RATES} AS fr ON fr.to_ccy = b.fx_report AND b.fx_date >= fr.date`;
}
