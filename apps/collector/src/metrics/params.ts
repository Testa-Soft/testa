/**
 * Shared query-parameter parser for all metric endpoints.
 *
 * Pure function: Record<string, string> in → ParseResult out. No I/O.
 * Each endpoint calls this first and returns 400 on error.
 */

import type { MetricRequestBase } from '@testa-platform/shared-types';

export type ParseOk = { ok: true; params: MetricRequestBase & { from: string; to: string } };
export type ParseError = { ok: false; status: 400; error: string; field: string };
export type ParseResult = ParseOk | ParseError;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function nDaysAgoIso(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function err(field: string, error: string): ParseError {
  return { ok: false, status: 400, error, field };
}

/**
 * Parse and validate the common query params shared by all metric endpoints.
 * The `query` argument is Hono's `c.req.query()` — a flat string record.
 */
export function parseMetricRequest(query: Record<string, string>): ParseResult {
  // experiment_id — required, positive integer
  const rawId = query.experiment_id;
  if (rawId === undefined || rawId === '') {
    return err('experiment_id', 'experiment_id is required');
  }
  const experimentId = Number(rawId);
  if (!Number.isInteger(experimentId) || experimentId <= 0) {
    return err('experiment_id', 'experiment_id must be a positive integer');
  }

  // report_currency — required, ISO-4217 shape
  const ccy = query.report_currency;
  if (ccy === undefined || ccy === '') {
    return err('report_currency', 'report_currency is required');
  }
  if (!CURRENCY_RE.test(ccy)) {
    return err('report_currency', 'report_currency must be 3 uppercase letters (ISO-4217)');
  }

  // from / to — optional ISO dates; default = last 30 days
  const rawFrom = query.from;
  const rawTo = query.to;

  if (rawFrom !== undefined && !ISO_DATE_RE.test(rawFrom)) {
    return err('from', 'from must be an ISO date (YYYY-MM-DD)');
  }
  if (rawTo !== undefined && !ISO_DATE_RE.test(rawTo)) {
    return err('to', 'to must be an ISO date (YYYY-MM-DD)');
  }
  if (rawFrom !== undefined && rawTo !== undefined && rawFrom > rawTo) {
    return err('from', 'from must be <= to');
  }

  return {
    ok: true,
    params: {
      experiment_id: experimentId,
      report_currency: ccy,
      from: rawFrom ?? nDaysAgoIso(30),
      to: rawTo ?? todayIso(),
    },
  };
}
