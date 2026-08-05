import { describe, expect, it } from 'vitest';
import { parsePacked, serializePacked } from '../packed-cookie.ts';

describe('packed _testa_exp codec', () => {
  it('round-trips a multi-experiment cookie', () => {
    const raw = '101.2.0.1720450000~102.1.1.1720450500';
    const map = parsePacked(raw);
    expect(map.get(101)).toEqual({ variation: 2, excluded: false, sessionExp: 1720450000 });
    expect(map.get(102)).toEqual({ variation: 1, excluded: true, sessionExp: 1720450500 });
    expect(serializePacked(map)).toBe(raw);
  });

  it('treats null / empty as no state', () => {
    expect(parsePacked(null).size).toBe(0);
    expect(parsePacked('').size).toBe(0);
    expect(serializePacked(new Map())).toBe('');
  });

  it('serializes experiment_id-sorted regardless of insertion order', () => {
    const map = parsePacked('102.1.0.0~101.2.0.0');
    expect(serializePacked(map)).toBe('101.2.0.0~102.1.0.0');
  });

  it('skips malformed segments instead of throwing', () => {
    const map = parsePacked('garbage~101.2.0.0~.5.0.0~103');
    expect([...map.keys()]).toEqual([101]);
    expect(map.get(101)?.variation).toBe(2);
  });

  it('defaults a missing sessionExp field to 0', () => {
    const map = parsePacked('101.2.0');
    expect(map.get(101)).toEqual({ variation: 2, excluded: false, sessionExp: 0 });
  });
});
