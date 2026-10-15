import { describe, expect, it } from 'vitest';
import {
  activeExpSessions,
  isExpSessionActive,
  normalizeExpiry,
  slideExpSession,
  startExpSessionIfNeeded,
} from '../exp-session.ts';

const T = 1_760_433_600;
const assigned = { variation: 2, excluded: false, sessionExp: 0 };

describe('PRD-006 experiment sessions (pure)', () => {
  it('starts session 1, stays active for 3600 s, slides, and a later start is idx 2', () => {
    const s1 = startExpSessionIfNeeded(assigned, T);
    expect(s1).toEqual({ ...assigned, sessionStart: T, sessionIdx: 1, sessionExp: T + 3600 });
    expect(startExpSessionIfNeeded(s1 ?? undefined, T + 59 * 60)).toBeNull();
    expect(isExpSessionActive(s1 ?? undefined, T + 61 * 60)).toBe(false);
    const slid = slideExpSession(s1 as never, T + 50 * 60);
    expect(isExpSessionActive(slid, T + 100 * 60)).toBe(true);
    expect(startExpSessionIfNeeded(slid, T + 2 * 86_400)?.sessionIdx).toBe(2);
  });

  it('excluded / sentinel entries never get sessions', () => {
    expect(startExpSessionIfNeeded({ variation: -1, excluded: true, sessionExp: 0 }, T)).toBeNull();
    expect(
      startExpSessionIfNeeded({ variation: -2, excluded: false, sessionExp: 0 }, T),
    ).toBeNull();
  });

  it('activeExpSessions lists only active tuples', () => {
    const map = new Map([
      [
        1,
        {
          variation: 10,
          excluded: false,
          sessionExp: T + 10,
          sessionStart: T - 100,
          sessionIdx: 3,
        },
      ],
      [
        2,
        {
          variation: 20,
          excluded: false,
          sessionExp: T - 1,
          sessionStart: T - 4000,
          sessionIdx: 1,
        },
      ],
    ]);
    expect(activeExpSessions((id) => map.get(id), [1, 2, 3], T)).toEqual([[1, 10, T - 100, 3]]);
  });

  it('legacy millisecond values read as last touch + 1 h', () => {
    expect(normalizeExpiry(T * 1000)).toBe(T + 3600);
    expect(normalizeExpiry(T)).toBe(T);
  });
});
