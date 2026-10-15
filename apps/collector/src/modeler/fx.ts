/**
 * Money conversion for the modeler (PRD-006 §5.1): each order converts to the
 * reporting currency at the PREVIOUS UTC day's rate, falling back to the last
 * known rate on or before that day. `fx_rates_history` holds USD-based rates
 * (USD → X), so  amount_R = amount_C / rate(USD→C) × rate(USD→R).
 *
 * Wraps a SELECT that has `currency` and `client_ts` columns and adds `fx`
 * (multiplier into {report_currency}; 1 for same currency, 0 when a rate is
 * unknown or the event has no currency, so the value drops out of sums).
 *
 * Local to P4 until task 5.19 (P2) ships the shared `fxSqlExpr`; P6 dedupes.
 */

const USD_RATES = `(SELECT to_ccy, date, rate FROM fx_rates_history FINAL WHERE from_ccy = 'USD')`;

export function withFx(innerSelect: string): string {
  return `
    SELECT
      b.*,
      multiIf(
        b.currency = '', 0,
        b.currency = b.fx_report, 1,
        fc.rate = 0 OR fr.rate = 0, 0,
        fr.rate / fc.rate
      ) AS fx
    FROM (
      SELECT i.*, toDate(i.client_ts) - 1 AS fx_date, {report_currency:String} AS fx_report
      FROM (${innerSelect}) AS i
    ) AS b
    ASOF LEFT JOIN ${USD_RATES} AS fc ON fc.to_ccy = b.currency AND b.fx_date >= fc.date
    ASOF LEFT JOIN ${USD_RATES} AS fr ON fr.to_ccy = b.fx_report AND b.fx_date >= fr.date`;
}
