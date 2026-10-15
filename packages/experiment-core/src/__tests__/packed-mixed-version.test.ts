/**
 * Mixed-version compatibility of the `_testa_exp` cookie (task 5.5 review):
 * customers run published @testa-soft/next|react 1.5.0 next to the pixel.
 *
 * `sessionExp` keeps its published 1.5.0 meaning (epoch-SECONDS expiry,
 * `isFresh`: sessionExp > nowSec). PRD-006 adds fields 5–6 only.
 */
import { describe, expect, it } from 'vitest';
import { parsePacked, serializePacked } from '../packed-cookie.ts';
import { isFresh } from '../session.ts';
import * as v150 from './fixtures/packed-cookie-1.5.0.ts';

const NOW_SEC = 1_760_433_600;

describe('1.5.0-written cookies read by the new code', () => {
  it('4-field segments decode identically (assignment, exclusion, seconds expiry)', () => {
    const map = new Map([
      [101, { variation: 2, excluded: false, sessionExp: NOW_SEC + 1800 }],
      [102, { variation: -1, excluded: true, sessionExp: NOW_SEC + 60 }],
    ]);
    const raw = v150.serializePacked(map);
    expect(parsePacked(raw)).toEqual(v150.parsePacked(raw));
    expect(isFresh(parsePacked(raw).get(101), NOW_SEC)).toBe(true);
  });
});

describe('new-written cookies read by the 1.5.0 decoder', () => {
  const fresh = parsePacked('');
  fresh.set(101, {
    variation: 2,
    excluded: false,
    sessionExp: NOW_SEC + 3600,
    sessionStart: NOW_SEC,
    sessionIdx: 2,
  });
  fresh.set(102, { variation: 1, excluded: false, sessionExp: 0 });
  const raw = serializePacked(fresh);

  it('keeps every assignment, exclusion flag and the seconds expiry', () => {
    const old = v150.parsePacked(raw);
    expect(old.get(101)).toEqual({ variation: 2, excluded: false, sessionExp: NOW_SEC + 3600 });
    expect(old.get(102)).toEqual({ variation: 1, excluded: false, sessionExp: 0 });
  });

  it('a 1.5.0 seconds-expiry check sees the PRD-006 session as live (same unit)', () => {
    const state = v150.parsePacked(raw).get(101);
    expect(state && (state.sessionExp === 0 || state.sessionExp > NOW_SEC)).toBe(true);
  });

  it('known limitation: a 1.5.0 REWRITE drops fields 5–6 (assignments survive)', () => {
    const rewritten = v150.serializePacked(v150.parsePacked(raw));
    expect(rewritten).toBe(`101.2.0.${NOW_SEC + 3600}~102.1.0.0`);
    expect(parsePacked(rewritten).get(101)).toEqual({
      variation: 2,
      excluded: false,
      sessionExp: NOW_SEC + 3600,
    });
  });
});
