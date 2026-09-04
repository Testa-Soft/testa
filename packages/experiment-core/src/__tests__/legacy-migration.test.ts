/**
 * 3.x → v2 cookie adoption. The cases that matter are the ones where a naive
 * implementation looks like it works: control visitors (`'0'`), visitors the
 * legacy script evaluated and PASSED (`_testa_excl=0`), and the two clocks.
 */

import { describe, expect, it } from 'vitest';
import { assign } from '../assign.ts';
import { ASSIGNMENT_COOKIE } from '../cookie-store.ts';
import {
  LEGACY_SESSION_LENGTH_SEC,
  discoverLegacyExperimentIds,
  maybeMigrateLegacyCookies,
  migrateLegacyCookies,
} from '../legacy-migration.ts';
import {
  ELIGIBLE_PENDING_VARIATION_ID,
  EXCLUDED_VARIATION_ID,
  parsePacked,
} from '../packed-cookie.ts';
import { memoryStore } from './memory-store.ts';

const NOW_MS = 1_760_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);
const SESSION = 30 * 60;
const CTX = { nowMs: NOW_MS, sessionLengthSec: SESSION };

const stateOf = (store: { get(n: string): string | null }, id: number) =>
  parsePacked(store.get(ASSIGNMENT_COOKIE)).get(id);

describe('migrateLegacyCookies', () => {
  it('adopts a legacy variation into the packed cookie', () => {
    const store = memoryStore({ _testa_exp_101: '1' });

    const result = migrateLegacyCookies(CTX, store);

    expect(result.assignments).toEqual([101]);
    expect(stateOf(store, 101)).toMatchObject({ variation: 1, excluded: false });
  });

  it('adopts CONTROL — a legacy value of "0" is an assignment, not an absence', () => {
    const store = memoryStore({ _testa_exp_101: '0' });

    const result = migrateLegacyCookies(CTX, store);

    expect(result.assignments).toEqual([101]);
    expect(stateOf(store, 101)?.variation).toBe(0);
  });

  it('makes assign() sticky for a migrated visitor — no re-bucket', () => {
    const store = memoryStore({ _testa_exp_101: '1' });
    migrateLegacyCookies(CTX, store);

    const decision = assign(
      {
        experiment_id: 101,
        traffic_allocation: 100,
        variations: [
          { variation_id: 0, weight: 50 },
          { variation_id: 1, weight: 50 },
        ],
      },
      { visitorId: 'visitor-that-would-bucket-to-control' },
      store,
    );

    expect(decision).toMatchObject({ variationId: 1, fromCookie: true });
  });

  it('adopts a cached EXCLUSION verdict', () => {
    const store = memoryStore({ _testa_excl_101: '1' });

    const result = migrateLegacyCookies(CTX, store);

    expect(result.verdicts).toEqual([101]);
    expect(stateOf(store, 101)).toEqual({
      variation: EXCLUDED_VARIATION_ID,
      excluded: true,
      sessionExp: NOW_SEC + SESSION,
    });
  });

  it('adopts a cached ELIGIBLE verdict — `_testa_excl=0` means evaluated and PASSED', () => {
    const store = memoryStore({ _testa_excl_101: '0' });

    const result = migrateLegacyCookies(CTX, store);

    expect(result.verdicts).toEqual([101]);
    expect(stateOf(store, 101)).toMatchObject({
      variation: ELIGIBLE_PENDING_VARIATION_ID,
      excluded: false,
    });
  });

  it('reads the boolean spelling some builds wrote', () => {
    const store = memoryStore({ _testa_excl_101: 'true', _testa_excl_102: 'false' });

    migrateLegacyCookies(CTX, store);

    expect(stateOf(store, 101)?.excluded).toBe(true);
    expect(stateOf(store, 102)?.excluded).toBe(false);
  });

  it('prefers the assignment over the exclusion cookie when both exist', () => {
    const store = memoryStore({ _testa_exp_101: '1', _testa_excl_101: '0' });

    const result = migrateLegacyCookies(CTX, store);

    expect(result).toEqual({ assignments: [101], verdicts: [] });
    expect(stateOf(store, 101)?.variation).toBe(1);
  });

  it('converts the legacy session clock — ms since touch → epoch-second expiry', () => {
    const touchedMs = NOW_MS - 10 * 60 * 1000; // 10 min ago, still inside the 1h window
    const store = memoryStore({ _testa_exp_101: '1', _testa_ses_101: String(touchedMs) });

    migrateLegacyCookies(CTX, store);

    expect(stateOf(store, 101)?.sessionExp).toBe(
      Math.trunc(touchedMs / 1000) + LEGACY_SESSION_LENGTH_SEC,
    );
  });

  it('restarts a lapsed legacy session rather than adopting a dead one', () => {
    const store = memoryStore({
      _testa_exp_101: '1',
      _testa_ses_101: String(NOW_MS - 5 * 60 * 60 * 1000), // 5h ago
    });

    migrateLegacyCookies(CTX, store);

    expect(stateOf(store, 101)?.sessionExp).toBe(NOW_SEC + SESSION);
  });

  it('adopts a variation the config no longer lists — assign() re-checks it later', () => {
    const store = memoryStore({ _testa_exp_101: '99' });

    expect(migrateLegacyCookies(CTX, store).assignments).toEqual([101]);
  });

  it('never overwrites an existing packed entry', () => {
    const store = memoryStore({
      [ASSIGNMENT_COOKIE]: `101.0.0.${NOW_SEC + 999}`,
      _testa_exp_101: '1',
    });

    const result = migrateLegacyCookies(CTX, store);

    expect(result).toEqual({ assignments: [], verdicts: [] });
    expect(stateOf(store, 101)?.variation).toBe(0);
  });

  it('preserves packed entries for OTHER experiments while adopting one', () => {
    const store = memoryStore({
      [ASSIGNMENT_COOKIE]: `102.2.0.${NOW_SEC + 999}`,
      _testa_exp_101: '1',
    });

    migrateLegacyCookies(CTX, store);

    expect(stateOf(store, 101)?.variation).toBe(1);
    expect(stateOf(store, 102)?.variation).toBe(2);
  });

  it('adopts an experiment no config mentions — the jar is the source of truth', () => {
    // Deliberately NOT config-scoped: a host may have no config, a stale one, or
    // one that has dropped an experiment the visitor is still enrolled in.
    const store = memoryStore({ _testa_exp_777: '3' });

    expect(migrateLegacyCookies(CTX, store).assignments).toEqual([777]);
    expect(stateOf(store, 777)?.variation).toBe(3);
  });

  it('writes nothing at all for a visitor with no legacy state', () => {
    const store = memoryStore();

    migrateLegacyCookies(CTX, store);

    expect(store.dump()).toEqual({});
  });

  it('skips malformed and empty legacy values', () => {
    const store = memoryStore({ _testa_exp_101: '', _testa_exp_102: 'undefined' });

    expect(migrateLegacyCookies(CTX, store)).toEqual({
      assignments: [],
      verdicts: [],
    });
  });
});

describe('maybeMigrateLegacyCookies', () => {
  it('does nothing when the host has not opted in', () => {
    const store = memoryStore({ _testa_exp_101: '1' });

    const result = maybeMigrateLegacyCookies(undefined, CTX, store);

    expect(result).toEqual({ assignments: [], verdicts: [] });
    expect(store.get(ASSIGNMENT_COOKIE)).toBeNull();
  });

  it('runs when the host opted in', () => {
    const store = memoryStore({ _testa_exp_101: '1' });

    expect(maybeMigrateLegacyCookies(true, CTX, store).assignments).toEqual([101]);
  });
});

describe('discoverLegacyExperimentIds', () => {
  it('finds experiment ids from assignment and exclusion cookie names', () => {
    expect(
      discoverLegacyExperimentIds([
        '_testa_exp_103',
        '_testa_excl_7',
        '_testa_uuid',
        'session',
        '_testa_exp_12',
      ]),
    ).toEqual([7, 12, 103]);
  });

  it('never mistakes the packed cookie itself for an experiment', () => {
    expect(discoverLegacyExperimentIds(['_testa_exp', '_testa_exp_'])).toEqual([]);
  });

  it('de-duplicates an experiment carrying several legacy cookies', () => {
    expect(discoverLegacyExperimentIds(['_testa_exp_103', '_testa_excl_103'])).toEqual([103]);
  });

  it('ignores non-numeric suffixes', () => {
    expect(discoverLegacyExperimentIds(['_testa_exp_abc', '_testa_exp_1x'])).toEqual([]);
  });
});

describe('migrateLegacyCookies — without a config (cold host)', () => {
  it('keeps a visitor on the variation the legacy pixel gave them', () => {
    const store = memoryStore({ _testa_exp_103: '1' });

    const result = migrateLegacyCookies(CTX, store);

    expect(result.assignments).toEqual([103]);
    expect(stateOf(store, 103)).toMatchObject({ variation: 1, excluded: false });
  });

  it('adopts an experiment the config does not describe — the whole point of the cold path', () => {
    const store = memoryStore({ _testa_exp_999: '4' });

    migrateLegacyCookies(CTX, store);

    expect(stateOf(store, 999)?.variation).toBe(4);
  });

  it('still refuses a negative value — that is our sentinel space, not a variation', () => {
    const store = memoryStore({ _testa_exp_103: '-1' });

    expect(migrateLegacyCookies(CTX, store).assignments).toEqual([]);
  });

  it('is idempotent — a revisit after migration changes nothing', () => {
    const store = memoryStore({ _testa_exp_103: '1' });
    migrateLegacyCookies(CTX, store);
    const afterFirst = store.get(ASSIGNMENT_COOKIE);

    const second = migrateLegacyCookies(CTX, store);

    expect(second).toEqual({ assignments: [], verdicts: [] });
    expect(store.get(ASSIGNMENT_COOKIE)).toBe(afterFirst);
  });

  it('does not clobber a warm-host decision made after the migration', () => {
    // Migrated cold, then the visitor was moved by a real v2 decision (e.g. the
    // variation was retired and assign() re-bucketed them). The legacy cookie is
    // still in the jar for another 30 days and must not win it back.
    const store = memoryStore({
      [ASSIGNMENT_COOKIE]: `103.2.0.${NOW_SEC + 999}`,
      _testa_exp_103: '1',
    });

    migrateLegacyCookies(CTX, store);

    expect(stateOf(store, 103)?.variation).toBe(2);
  });
});
