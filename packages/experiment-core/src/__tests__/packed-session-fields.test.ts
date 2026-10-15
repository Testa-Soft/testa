/** PRD-006 experiment-session fields in the packed `_testa_exp` cookie (task 5.5). */
import { describe, expect, it } from 'vitest';
import { applyAssignment, assign } from '../assign.ts';
import { ASSIGNMENT_COOKIE } from '../cookie-store.ts';
import { parsePacked, serializePacked } from '../packed-cookie.ts';
import { cacheEligible, refreshSession } from '../session.ts';
import { memoryStore } from './memory-store.ts';

describe('packed codec — sessionStart / sessionIdx', () => {
  it('parses 6-field segments and round-trips them', () => {
    const raw = '101.2.0.1760437200.1760433600.2~102.1.0.0';
    const map = parsePacked(raw);
    expect(map.get(101)).toEqual({
      variation: 2,
      excluded: false,
      sessionExp: 1760437200,
      sessionStart: 1760433600,
      sessionIdx: 2,
    });
    expect(map.get(102)).toEqual({ variation: 1, excluded: false, sessionExp: 0 });
    expect(serializePacked(map)).toBe(raw);
  });

  it('old 4-field cookies parse with no session (sessionStart 0)', () => {
    expect(parsePacked('101.2.0.1720450000').get(101)).toEqual({
      variation: 2,
      excluded: false,
      sessionExp: 1720450000,
    });
  });

  it('5-field segments: sessionIdx = 1 when a session is active, else 0', () => {
    expect(parsePacked('101.2.0.1760437200.1760433600').get(101)).toMatchObject({
      sessionStart: 1760433600,
      sessionIdx: 1,
    });
    expect(parsePacked('101.2.0.1760437200.0').get(101)).not.toHaveProperty('sessionIdx');
  });

  it('entries without session fields serialize as 4 fields (older readers unaffected)', () => {
    const map = parsePacked('');
    map.set(7, { variation: 1, excluded: false, sessionExp: 5 });
    expect(serializePacked(map)).toBe('7.1.0.5');
  });

  it('a malformed 6th field degrades to no index instead of throwing', () => {
    expect(parsePacked('101.2.0.1.1760433600.x').get(101)).toMatchObject({
      sessionStart: 1760433600,
    });
  });
});

describe('server-side writers keep the session fields', () => {
  const seeded = () => memoryStore({ [ASSIGNMENT_COOKIE]: '101.2.0.1760437200.1760433600.3' });

  it('refreshSession keeps sessionStart/sessionIdx and never shortens a later expiry', () => {
    const store = seeded();
    refreshSession(store, 101, 2, 1760435000); // earlier than the stored 1760437200
    expect(parsePacked(store.get(ASSIGNMENT_COOKIE)).get(101)).toEqual({
      variation: 2,
      excluded: false,
      sessionExp: 1760437200,
      sessionStart: 1760433600,
      sessionIdx: 3,
    });
    refreshSession(store, 101, 2, 1760440000);
    expect(parsePacked(store.get(ASSIGNMENT_COOKIE)).get(101)?.sessionExp).toBe(1760440000);
  });

  it('refreshSession ignores a legacy millisecond value instead of keeping it forever', () => {
    const store = memoryStore({ [ASSIGNMENT_COOKIE]: '101.2.0.1760433600123' });
    refreshSession(store, 101, 2, 1760435000);
    expect(parsePacked(store.get(ASSIGNMENT_COOKIE)).get(101)?.sessionExp).toBe(1760435000);
  });

  it('cacheEligible and assign() preserve them', () => {
    const store = seeded();
    cacheEligible(store, 101, 1);
    expect(parsePacked(store.get(ASSIGNMENT_COOKIE)).get(101)).toMatchObject({
      sessionStart: 1760433600,
      sessionIdx: 3,
    });

    const fresh = memoryStore({ [ASSIGNMENT_COOKIE]: '5.-2.0.0.1760433600.4' });
    const result = assign(
      {
        experiment_id: 5,
        traffic_allocation: 100,
        variations: [{ variation_id: 50, weight: 100 }],
      },
      { visitorId: 'v', now: 0 },
      fresh,
    );
    expect(result.variationId).toBe(50);
    expect(parsePacked(fresh.get(ASSIGNMENT_COOKIE)).get(5)).toMatchObject({
      variation: 50,
      sessionStart: 1760433600,
      sessionIdx: 4,
    });
  });

  it('applyAssignment keeps history for the same variation, resets it for a different one', () => {
    const same = seeded();
    applyAssignment(same, 101, 2);
    expect(parsePacked(same.get(ASSIGNMENT_COOKIE)).get(101)).toMatchObject({ sessionIdx: 3 });
    const other = seeded();
    applyAssignment(other, 101, 9);
    expect(parsePacked(other.get(ASSIGNMENT_COOKIE)).get(101)).toEqual({
      variation: 9,
      excluded: false,
      sessionExp: 0,
    });
  });
});
