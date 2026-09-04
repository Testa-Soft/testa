/**
 * TEMPORARY — adoption of legacy 3.x per-experiment cookies into the packed
 * `_testa_exp` cookie, for projects cutting over from the crobot pixel to the
 * SDK while experiments are LIVE.
 *
 * ## Why this exists
 *
 * A v2 host reads only `_testa_exp`. A returning 3.x visitor has no such cookie,
 * so without this they are treated as brand new and re-bucketed. That is not a
 * rounding error: 3.x allocated with `Math.random()` (crobot
 * `integration/3.6/script.js`), so the re-roll is a coin flip, not a stable
 * rehash — roughly half of every returning visitor silently changes variation
 * mid-test. Their pre-cutover conversions stay attributed to the old variation
 * and their post-cutover ones to the new one, which contaminates both arms and
 * shows up as SRM.
 *
 * ## Why it is only a repack
 *
 * The v2 config carries crobot's own integers verbatim — the collector maps
 * `experiment_id: e.identifier` and `variation_id: v.identifier` (see
 * `apps/collector/src/config/build.ts`). Those are the SAME integers the legacy
 * script puts in its cookie names and values, so there is no id mapping, no
 * lookup table and no network call here: only a rename and a re-encode.
 *
 *   `_testa_exp_<expId>`  = `<variationId>`   → packed `expId.variationId.0.<exp>`
 *   `_testa_excl_<expId>` = `1`               → packed `expId.-1.1.<cooldown>`
 *   `_testa_excl_<expId>` = `0`               → packed `expId.-2.0.<cache>`
 *   `_testa_ses_<expId>`  = last touch, ms    → the packed entry's `sessionExp`
 *
 * Legacy cookies are READ, never cleared: deleting one requires reproducing the
 * `Domain` the legacy script wrote it with, and getting that wrong deletes
 * nothing while looking like it worked. They expire on their own within 30 days.
 *
 * The adopted variation is NOT checked against a config, even when one is at
 * hand. `assign()` already re-checks the stored variation on its cookie-first
 * path and re-buckets if it has since disappeared, so checking here would only
 * duplicate that — while making the outcome depend on which host ran, which is
 * the one thing a sticky assignment must never do.
 *
 * ## How this stops running
 *
 * Both brakes are keyed to the experiments themselves, never to a date — a
 * customer may cut over at any time, and a calendar cutoff would strand whoever
 * migrates after it:
 *
 *   1. Per visitor — an experiment that already has a packed entry is skipped,
 *      so a visitor is migrated once and then pays one `Map.get` per experiment.
 *   2. Per visitor's jar — the experiments migrated are the ones the visitor's
 *      own cookies name, NOT the ones some config happens to list. The config is
 *      deliberately not consulted: a host may have no config (a cold proxy), a
 *      stale one, or one that no longer mentions an experiment the visitor is
 *      still enrolled in — and in every one of those cases the assignment must
 *      survive. So the terminator is the legacy cookies' own ~30-day expiry:
 *      once they lapse there is nothing left to find, everywhere at once.
 *
 * ## Removal
 *
 * Delete this file, its test, the two `maybeMigrateLegacyCookies` call sites
 * (`@testa-soft/next` middleware, `@testa-soft/react` init) and their options.
 * Nothing else depends on it.
 */

import { ASSIGNMENT_COOKIE, ASSIGNMENT_TTL_SEC, type CookieStore } from './cookie-store.ts';
import {
  ELIGIBLE_PENDING_VARIATION_ID,
  EXCLUDED_VARIATION_ID,
  type ExpState,
  type PackedExpMap,
  parsePacked,
  serializePacked,
} from './packed-cookie.ts';

/** 3.x `Analytica.COOKIE_NAME + '_' + experiment.identifier`. */
const LEGACY_ASSIGNMENT_PREFIX = '_testa_exp_';
/** 3.x `Analytica.EXCLUDED_COOKIE + '_' + experiment.identifier`. */
const LEGACY_EXCLUSION_PREFIX = '_testa_excl_';
/** 3.x `Analytica.SESSION_COOKIE + '_' + experiment.identifier`. */
const LEGACY_SESSION_PREFIX = '_testa_ses_';

/** 3.x `window.Analytica.SESSION_LENGTH` — one hour, here in seconds. */
export const LEGACY_SESSION_LENGTH_SEC = 60 * 60;

/**
 * Legacy experiment ids present in a cookie jar, from the names alone.
 *
 * This is what makes the migration independent of any config: the visitor's own
 * cookies say which experiments they were in. A visitor assigned to experiment
 * 103 variation 1 by the legacy pixel keeps variation 1 on every later visit —
 * whether or not the instance serving them holds a config, and whether or not
 * that config still lists 103.
 *
 * Ids are returned sorted and de-duplicated so the resulting packed cookie is
 * stable regardless of cookie order.
 */
export function discoverLegacyExperimentIds(names: readonly string[]): number[] {
  const ids = new Set<number>();
  for (const name of names) {
    const prefix = [LEGACY_ASSIGNMENT_PREFIX, LEGACY_EXCLUSION_PREFIX].find((p) =>
      name.startsWith(p),
    );
    if (!prefix) continue;
    const raw = name.slice(prefix.length);
    // `_testa_exp` itself (the packed cookie) has no `_<id>` suffix, so it can
    // never be read back as an experiment of its own.
    if (!/^\d+$/.test(raw)) continue;
    ids.add(Number(raw));
  }
  return [...ids].sort((a, b) => a - b);
}

export interface LegacyMigrationContext {
  /** Epoch ms. Injectable for tests. */
  nowMs: number;
  /** Window applied to a migrated session / exclusion cooldown, in seconds. */
  sessionLengthSec: number;
}

export interface LegacyMigrationResult {
  /** Experiment ids that adopted a legacy VARIATION (control included). */
  assignments: number[];
  /** Experiment ids that adopted a legacy targeting verdict (no variation yet). */
  verdicts: number[];
}

const NOTHING: LegacyMigrationResult = { assignments: [], verdicts: [] };

/**
 * Adopt legacy state for `experiments` when the host asked for it.
 *
 * This is the entry point hosts call, kept to a single expression at each call
 * site so removal is a one-line delete.
 */
export function maybeMigrateLegacyCookies(
  enabled: boolean | undefined,
  ctx: LegacyMigrationContext,
  store: CookieStore,
): LegacyMigrationResult {
  if (!enabled) return NOTHING;
  return migrateLegacyCookies(ctx, store);
}

/**
 * The migration itself, unguarded — exported for tests and for a host that has
 * already made the decision to run it.
 *
 * Writes the packed cookie at most ONCE, and only when something was actually
 * adopted, so a visitor with no legacy state produces no `Set-Cookie` and no
 * response mutation at all.
 */
export function migrateLegacyCookies(
  ctx: LegacyMigrationContext,
  store: CookieStore,
): LegacyMigrationResult {
  const nowSec = Math.floor(ctx.nowMs / 1000);
  const packed = parsePacked(store.get(ASSIGNMENT_COOKIE));
  const assignments: number[] = [];
  const verdicts: number[] = [];
  const adopted: PackedExpMap = new Map(packed);

  for (const id of discoverLegacyExperimentIds(store.names?.() ?? [])) {
    // Already migrated, or decided natively by v2 — either way the packed
    // cookie is authoritative and legacy state is stale by definition.
    if (packed.has(id)) continue;

    const entry = adopt(id, nowSec, ctx.sessionLengthSec, store);
    if (!entry) continue;

    adopted.set(id, entry.state);
    (entry.kind === 'assignment' ? assignments : verdicts).push(id);
  }

  if (assignments.length > 0 || verdicts.length > 0) {
    store.set(ASSIGNMENT_COOKIE, serializePacked(adopted), { maxAgeSec: ASSIGNMENT_TTL_SEC });
  }

  return { assignments, verdicts };
}

interface AdoptedEntry {
  kind: 'assignment' | 'verdict';
  state: ExpState;
}

function adopt(
  id: number,
  nowSec: number,
  sessionLengthSec: number,
  store: CookieStore,
): AdoptedEntry | null {
  const variation = readLegacyVariation(store, id);
  if (variation !== null) {
    return {
      kind: 'assignment',
      state: {
        variation,
        excluded: false,
        sessionExp: sessionExpiryOf(store, id, nowSec, sessionLengthSec),
      },
    };
  }

  // No assignment: the visitor may still carry a cached first-touch targeting
  // verdict, which is worth keeping — re-evaluating targeting on a later,
  // UTM-less page is how an eligible visitor gets wrongly excluded.
  const excluded = readLegacyVerdict(store, id);
  if (excluded === null) return null;

  return {
    kind: 'verdict',
    state: excluded
      ? {
          variation: EXCLUDED_VARIATION_ID,
          excluded: true,
          sessionExp: nowSec + sessionLengthSec,
        }
      : {
          variation: ELIGIBLE_PENDING_VARIATION_ID,
          excluded: false,
          sessionExp: nowSec + sessionLengthSec,
        },
  };
}

/**
 * The legacy variation for an experiment, or null when there isn't a usable one.
 *
 * Deliberately not validated against any config — see the note at the top of
 * this file. `assign()` re-checks it later, where a config is always present.
 *
 * `'0'` IS a value — it is the CONTROL variation (the collector's
 * `identifier <= 0` branch). Any truthiness check here silently re-buckets every
 * control visitor on the site, which is the failure this whole module exists to
 * prevent, applied to exactly half the population.
 */
function readLegacyVariation(store: CookieStore, experimentId: number): number | null {
  const raw = store.get(`${LEGACY_ASSIGNMENT_PREFIX}${experimentId}`);
  if (raw === null || raw.trim() === '') return null;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  const variation = Math.trunc(parsed);

  // Legacy variation identifiers are non-negative (control is 0). Negatives are
  // OUR sentinel space (-1 excluded, -2 eligible-pending), so a negative in a
  // legacy cookie is corruption that would otherwise be read back as a verdict.
  if (variation < 0) return null;

  return variation;
}

/**
 * The legacy targeting verdict: true = excluded, false = evaluated and eligible,
 * null = never evaluated.
 *
 * PRESENCE IS NOT EXCLUSION. 3.x writes this cookie on first touch with the
 * verdict either way — `setCookie(excludedCookieString(id), shouldExclude, 2)`
 * in `integration/3.6/script.js` stores `0` for a visitor who PASSED. Treating
 * the cookie's existence as "excluded" locks out every visitor the legacy script
 * ever evaluated, which on a live site is all of them.
 */
function readLegacyVerdict(store: CookieStore, experimentId: number): boolean | null {
  const raw = store.get(`${LEGACY_EXCLUSION_PREFIX}${experimentId}`);
  if (raw === null) return null;

  // Numeric across most versions, but `handleExperiment` has passed a boolean
  // through `setCookie` in some builds, which stringifies to `true`/`false`.
  const value = raw.trim().toLowerCase();
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  return null;
}

/**
 * Convert the legacy session cookie into a packed `sessionExp`.
 *
 * The two are not the same clock: 3.x stores the last TOUCH in epoch
 * MILLISECONDS and calls the session live while `now - touched < SESSION_LENGTH`,
 * while v2 stores the EXPIRY in epoch SECONDS. Copying the number across would
 * put every migrated session ~50,000 years in the future.
 *
 * This pageview is itself a touch — 3.x slides the window on every handled
 * pageview — so a legacy window that has already lapsed restarts here rather
 * than arriving dead and suppressing conversion attribution.
 */
function sessionExpiryOf(
  store: CookieStore,
  experimentId: number,
  nowSec: number,
  sessionLengthSec: number,
): number {
  const raw = store.get(`${LEGACY_SESSION_PREFIX}${experimentId}`);
  const touchedMs = raw === null ? Number.NaN : Number(raw);
  const legacyExpirySec = Number.isFinite(touchedMs)
    ? Math.trunc(touchedMs / 1000) + LEGACY_SESSION_LENGTH_SEC
    : 0;

  return Math.max(legacyExpirySec, nowSec + sessionLengthSec);
}
