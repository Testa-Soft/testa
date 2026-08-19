// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import {
  type VariationEvent,
  emitVariationApplied,
  emitVariationAssigned,
  installTestaGlobal,
  onVariationApplied,
  onVariationAssigned,
} from '../bus.ts';

const ev = (over: Partial<VariationEvent> = {}): VariationEvent => ({
  project_id: 1,
  experiment: 10,
  variation: 2,
  uuid: 'u',
  title: 'Test',
  url: 'https://s.com/x',
  ...over,
});

afterEach(() => {
  (window as unknown as { dataLayer?: unknown[] }).dataLayer = [];
});

describe('event bus', () => {
  it('delivers variation_applied to multiple handlers', () => {
    const seen: number[] = [];
    onVariationApplied((e) => seen.push(e.variation));
    onVariationApplied((e) => seen.push(e.variation + 100));
    emitVariationApplied(ev({ experiment: 111 }));
    expect(seen.sort((a, b) => a - b)).toEqual([2, 102]);
  });

  it('replays history to a late-registered handler', () => {
    emitVariationApplied(ev({ experiment: 222 }));
    let got: VariationEvent | null = null;
    onVariationApplied((e) => {
      if (e.experiment === 222) got = e;
    });
    expect(got).not.toBeNull();
  });

  it('pushes the 3.3.3 dataLayer shape, once per (exp,var) per load', () => {
    emitVariationApplied(ev({ experiment: 333, variation: 1, title: 'Hero' }));
    emitVariationApplied(ev({ experiment: 333, variation: 1, title: 'Hero' })); // dup → ignored
    const dl = (
      window as unknown as { dataLayer: Array<Record<string, unknown>> }
    ).dataLayer.filter((d) => d.ExperimentId === 333);
    expect(dl).toHaveLength(1);
    expect(dl[0]).toMatchObject({
      event: 'Analytica',
      ExperimentId: 333,
      VariationId: 1,
      VariationName: 'Variation1',
    });
  });

  it('names control as Control', () => {
    emitVariationApplied(ev({ experiment: 444, variation: 0 }));
    const dl = (window as unknown as { dataLayer: Array<Record<string, unknown>> }).dataLayer.find(
      (d) => d.ExperimentId === 444,
    );
    expect(dl?.VariationName).toBe('Control');
  });

  it('unsubscribe stops delivery', () => {
    let count = 0;
    const off = onVariationAssigned(() => count++);
    emitVariationAssigned(ev({ experiment: 555 }));
    off();
    emitVariationAssigned(ev({ experiment: 556 }));
    expect(count).toBe(1);
  });

  it('installs window.testa', () => {
    installTestaGlobal();
    expect(
      typeof (window as unknown as { testa?: { onVariationApplied: unknown } }).testa
        ?.onVariationApplied,
    ).toBe('function');
  });
});
