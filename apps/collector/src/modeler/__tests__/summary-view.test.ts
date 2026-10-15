import { describe, expect, it } from 'bun:test';
import { views } from '../../analytics/views.ts';
import { validateSummaryParams } from '../summary-view.ts';

const ok = {
  from: '2026-10-01',
  to: '2026-10-14',
  metrics: ['purchase', 'event:size_guide_opened', 'goal:12'],
};

function failure(raw: unknown): unknown {
  try {
    validateSummaryParams(raw);
  } catch (err) {
    const e = err as { status?: number; toBody?: () => unknown };
    return { status: e.status, body: e.toBody?.() };
  }
  return null;
}

describe('summary view', () => {
  it('registers itself', () => {
    expect(views.has('summary')).toBe(true);
  });

  it('accepts a valid body (dimension, cap_outliers, currency)', () => {
    expect(
      validateSummaryParams({
        ...ok,
        dimension: 'device_type',
        cap_outliers: true,
        report_currency: 'USD',
      }),
    ).toEqual({
      ...ok,
      metrics: ['purchase', 'event:size_guide_opened', 'goal:12'],
      dimension: 'device_type',
      cap_outliers: true,
      report_currency: 'USD',
    });
  });

  it.each([
    [{ ...ok, metrics: ['aov'] }, 'unknown_metric', 'aov'],
    [{ ...ok, metrics: [] }, 'unknown_metric', 'metrics'],
    [{ ...ok, dimension: 'ip' }, 'unknown_dimension', 'ip'],
    [{ ...ok, from: '2026-10-15' }, 'invalid_range', 'from'],
    [{ ...ok, from: '2025-01-01' }, 'invalid_range', 'from'],
    [{ ...ok, to: 'yesterday' }, 'invalid_range', 'to'],
    [{ ...ok, report_currency: 'eur' }, 'invalid_currency', 'report_currency'],
  ])('rejects %p with %s', (raw, error, field) => {
    expect(failure(raw)).toEqual({ status: 400, body: { error, field } });
  });
});
