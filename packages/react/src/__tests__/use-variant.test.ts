import { describe, expect, it } from 'vitest';
import { buildAssignmentMap, controlVariationId, resolveVariant } from '../use-variant.ts';
import { firstExperiment, splitUrlConfig } from './helpers.ts';

describe('buildAssignmentMap', () => {
  it('maps experimentId → variationId, dropping excluded', () => {
    // 101 → variation 2, 102 → excluded (~ separates experiments).
    const map = buildAssignmentMap('101.2.0.0~102.-1.1.0');
    expect(map.get(101)).toBe(2);
    expect(map.has(102)).toBe(false);
  });

  it('returns an empty map for null / empty cookie', () => {
    expect(buildAssignmentMap(null).size).toBe(0);
    expect(buildAssignmentMap('').size).toBe(0);
  });
});

describe('controlVariationId', () => {
  it('is the lowest variation_id', () => {
    expect(controlVariationId(firstExperiment(splitUrlConfig()))).toBe(1);
  });

  it('is null for an experiment with no variations', () => {
    const exp = firstExperiment(splitUrlConfig());
    exp.variations = [];
    expect(controlVariationId(exp)).toBeNull();
  });
});

describe('resolveVariant', () => {
  const config = splitUrlConfig();

  it('returns the assigned variant, isControl false for a variant', () => {
    const map = buildAssignmentMap('101.2.0.0');
    expect(resolveVariant(config, map, 101)).toEqual({ variationId: 2, isControl: false });
  });

  it('flags the control variation', () => {
    const map = buildAssignmentMap('101.1.0.0');
    expect(resolveVariant(config, map, 101)).toEqual({ variationId: 1, isControl: true });
  });

  it('returns null when not assigned', () => {
    expect(resolveVariant(config, new Map(), 101)).toEqual({ variationId: null, isControl: false });
  });

  it('returns null when config is missing', () => {
    const map = buildAssignmentMap('101.2.0.0');
    expect(resolveVariant(null, map, 101)).toEqual({ variationId: null, isControl: false });
  });

  it('handles an unknown experiment id (assigned but not in config)', () => {
    const map = buildAssignmentMap('999.2.0.0');
    expect(resolveVariant(config, map, 999)).toEqual({ variationId: 2, isControl: false });
  });
});
