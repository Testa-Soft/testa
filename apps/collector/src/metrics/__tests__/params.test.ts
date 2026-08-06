import { describe, expect, it } from 'bun:test';
import { parseMetricRequest } from '../params.ts';

describe('parseMetricRequest', () => {
  const baseValid = { experiment_id: '42', report_currency: 'USD' };

  it('returns ok with defaults when only required params provided', () => {
    const result = parseMetricRequest(baseValid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.params.experiment_id).toBe(42);
    expect(result.params.report_currency).toBe('USD');
    // Defaults: from = 30 days ago, to = today — just check they're ISO dates
    expect(result.params.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.params.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.params.from <= result.params.to).toBe(true);
  });

  it('accepts explicit from/to dates', () => {
    const result = parseMetricRequest({
      ...baseValid,
      from: '2025-01-01',
      to: '2025-03-31',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.params.from).toBe('2025-01-01');
    expect(result.params.to).toBe('2025-03-31');
  });

  it('returns error when experiment_id is missing', () => {
    const result = parseMetricRequest({ report_currency: 'EUR' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe('experiment_id');
    expect(result.status).toBe(400);
  });

  it('returns error when experiment_id is empty string', () => {
    const result = parseMetricRequest({ experiment_id: '', report_currency: 'EUR' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe('experiment_id');
  });

  it('returns error when experiment_id is not an integer', () => {
    const result = parseMetricRequest({ experiment_id: '1.5', report_currency: 'USD' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe('experiment_id');
  });

  it('returns error when experiment_id is zero', () => {
    const result = parseMetricRequest({ experiment_id: '0', report_currency: 'USD' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe('experiment_id');
  });

  it('returns error when experiment_id is negative', () => {
    const result = parseMetricRequest({ experiment_id: '-1', report_currency: 'USD' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe('experiment_id');
  });

  it('returns error when report_currency is missing', () => {
    const result = parseMetricRequest({ experiment_id: '1' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe('report_currency');
  });

  it('returns error when report_currency is not 3 uppercase letters', () => {
    for (const bad of ['usd', 'US', 'USD1', 'us1']) {
      const result = parseMetricRequest({ experiment_id: '1', report_currency: bad });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.field).toBe('report_currency');
    }
  });

  it('returns error when from is not a valid ISO date', () => {
    const result = parseMetricRequest({ ...baseValid, from: '01-01-2025' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe('from');
  });

  it('returns error when to is not a valid ISO date', () => {
    const result = parseMetricRequest({ ...baseValid, to: '2025/01/01' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe('to');
  });

  it('returns error when from > to', () => {
    const result = parseMetricRequest({
      ...baseValid,
      from: '2025-06-01',
      to: '2025-01-01',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe('from');
    expect(result.error).toMatch(/<=|less than or equal/i);
  });

  it('allows from === to (single-day window)', () => {
    const result = parseMetricRequest({
      ...baseValid,
      from: '2025-03-15',
      to: '2025-03-15',
    });
    expect(result.ok).toBe(true);
  });
});
