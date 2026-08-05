/**
 * Pixel-side cookie API.
 *
 * Owns reads + writes for every `_testa_*` cookie except `_testa_uuid` —
 * that one is set by the edge worker via `Set-Cookie` header (first-party
 * context) and we only read it here. JS writes to `_testa_uuid` are
 * forbidden because Safari ITP caps them at 7 days.
 *
 * Cookies covered (matches `docs/reference/legacy-globals-inventory.md`):
 *
 *   _testa_uuid               persistent visitor id (worker-set, JS-read-only)
 *   _testa_ses_<expId>        per-experiment session (1h sliding TTL)
 *   _testa_exp_<expId>        per-experiment variation assignment (30d)
 *   _testa_excl_<expId>       per-experiment exclusion flag (30d)
 *   _testa_user_<expId>       per-experiment first-seen timestamp (30d)
 *   _testa_freq_<expId>       per-experiment frequency-cap counter (window-bound TTL)  [4.0 new]
 *   _testa_mutex_<group>      per-mutex-group active assignment (30d)                   [4.0 new]
 *
 * Storage strategy: every write goes to document.cookie + localStorage mirror.
 * Reads check both, falling through to sessionStorage as a last resort.
 * (See `./storage.ts` for the underlying primitives.)
 */

import {
  type CookieStore,
  type ExpState,
  parsePacked,
  serializePacked,
} from '@testa-platform/experiment-core';
import { SECONDS_PER_DAY, SECONDS_PER_HOUR, eraseValue, readValue, writeValue } from './storage.ts';

/**
 * Browser-backed `CookieStore` (storage.ts). Lets experiment-core's host-agnostic
 * logic (redirect dedup, etc.) run in the pixel exactly as it does in the
 * middleware — same code, same cookie effects.
 */
export const cookieStore: CookieStore = {
  get: (name) => readValue(name),
  set: (name, value, opts) => writeValue(name, value, { maxAgeSec: opts.maxAgeSec }),
};

// ─── cookie name constants (kept in sync with legacy-globals-inventory.md) ──

export const UUID_COOKIE = '_testa_uuid';
export const SESSION_COOKIE = '_testa_ses';
export const ASSIGNMENT_COOKIE = '_testa_exp';
export const EXCLUSION_COOKIE = '_testa_excl';
export const FIRST_SEEN_COOKIE = '_testa_user';
export const FREQ_COOKIE = '_testa_freq';
export const MUTEX_COOKIE = '_testa_mutex';

export const SESSION_LENGTH_SEC = SECONDS_PER_HOUR;
export const ASSIGNMENT_TTL_SEC = 30 * SECONDS_PER_DAY;

// ─── name builders (freq + mutex + first-seen stay per-experiment) ────────────

export const firstSeenName = (experimentId: number | string): string =>
  `${FIRST_SEEN_COOKIE}_${experimentId}`;

export const freqName = (experimentId: number | string): string => `${FREQ_COOKIE}_${experimentId}`;

export const mutexName = (groupName: string): string => `${MUTEX_COOKIE}_${groupName}`;

// ─── packed `_testa_exp` helpers (SAME codec + cookie the middleware uses) ─────
//
// Assignment, exclusion and session for ALL experiments live in one positional
// cookie `_testa_exp` (`expId.variation.excluded.sessionExp` per experiment).
// This is what makes the pixel and the Next.js middleware share cookie state.

function readPacked(): Map<number, ExpState> {
  return parsePacked(readValue(ASSIGNMENT_COOKIE));
}

function writePacked(map: Map<number, ExpState>): void {
  writeValue(ASSIGNMENT_COOKIE, serializePacked(map), { maxAgeSec: ASSIGNMENT_TTL_SEC });
}

function entryOf(experimentId: number | string): ExpState | null {
  return readPacked().get(Number(experimentId)) ?? null;
}

function upsertEntry(experimentId: number | string, patch: Partial<ExpState>): void {
  const map = readPacked();
  const id = Number(experimentId);
  const current = map.get(id) ?? { variation: -1, excluded: false, sessionExp: 0 };
  map.set(id, { ...current, ...patch });
  writePacked(map);
}

// ─── _testa_uuid ────────────────────────────────────────────────────────────

/**
 * Read the worker-set visitor UUID. Returns null on first visit (worker
 * mints + sets via response Set-Cookie; pixel sees it on the next pageload).
 */
export function getUuid(): string | null {
  return readValue(UUID_COOKIE);
}

// ─── assignment / session / exclusion — all packed into `_testa_exp` ─────────

export function getAssignment(experimentId: number | string): number | null {
  const entry = entryOf(experimentId);
  return entry && entry.variation >= 0 ? entry.variation : null;
}

export function setAssignment(experimentId: number | string, variationId: number): void {
  upsertEntry(experimentId, { variation: variationId, excluded: false });
}

export function clearAssignment(experimentId: number | string): void {
  const map = readPacked();
  map.delete(Number(experimentId));
  writePacked(map);
}

/**
 * Returns the session's stored ms timestamp, or null if absent. Callers compare
 * against Date.now() to decide if the session is still active.
 */
export function getSession(experimentId: number | string): number | null {
  const entry = entryOf(experimentId);
  return entry && entry.sessionExp > 0 ? entry.sessionExp : null;
}

/** Bump (or initialize) the session to "now". */
export function bumpSession(experimentId: number | string): void {
  upsertEntry(experimentId, { sessionExp: Date.now() });
}

export function getExclusion(experimentId: number | string): boolean {
  return entryOf(experimentId)?.excluded ?? false;
}

export function setExclusion(experimentId: number | string, excluded: boolean): void {
  upsertEntry(experimentId, { excluded });
}

// ─── per-experiment first-seen ──────────────────────────────────────────────

export function getFirstSeen(experimentId: number | string): number | null {
  const raw = readValue(firstSeenName(experimentId));
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function setFirstSeen(experimentId: number | string, ts: number): void {
  writeValue(firstSeenName(experimentId), String(ts), {
    maxAgeSec: ASSIGNMENT_TTL_SEC,
  });
}

// ─── frequency cap counter (4.0 new) ────────────────────────────────────────

export interface FreqCounter {
  count: number;
  window_start_ts: number;
}

/**
 * Read the freq counter for an experiment. Returns null if absent or if the
 * stored value is malformed. Callers are responsible for window-expiry checks
 * (compare window_start_ts to now).
 */
export function getFreq(experimentId: number | string): FreqCounter | null {
  const raw = readValue(freqName(experimentId));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<FreqCounter>;
    if (
      typeof parsed.count === 'number' &&
      typeof parsed.window_start_ts === 'number' &&
      Number.isFinite(parsed.count) &&
      Number.isFinite(parsed.window_start_ts)
    ) {
      return { count: parsed.count, window_start_ts: parsed.window_start_ts };
    }
  } catch {
    // fall through
  }
  return null;
}

export function setFreq(
  experimentId: number | string,
  counter: FreqCounter,
  windowDurationSec: number,
): void {
  writeValue(freqName(experimentId), JSON.stringify(counter), {
    maxAgeSec: windowDurationSec,
  });
}

export function clearFreq(experimentId: number | string): void {
  eraseValue(freqName(experimentId));
}

// ─── mutex group (4.0 new) ──────────────────────────────────────────────────

/**
 * Returns the experiment_id currently holding the mutex group, or null.
 */
export function getMutex(groupName: string): number | null {
  const raw = readValue(mutexName(groupName));
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function setMutex(groupName: string, experimentId: number): void {
  writeValue(mutexName(groupName), String(experimentId), {
    maxAgeSec: ASSIGNMENT_TTL_SEC,
  });
}

export function clearMutex(groupName: string): void {
  eraseValue(mutexName(groupName));
}

// ─── bulk wipe (test + integration helper) ──────────────────────────────────

/**
 * Erase EVERY `_testa_*` cookie that we know about for the given experiment.
 * UUID is not touched (worker owns it).
 *
 * Useful for QA flows ("reset me to a fresh visitor for this experiment")
 * and for the consent-revoke path (Phase 3.4).
 */
export function clearExperiment(experimentId: number | string): void {
  // assignment/exclusion/session all live in the packed `_testa_exp` entry.
  clearAssignment(experimentId);
  eraseValue(firstSeenName(experimentId));
  eraseValue(freqName(experimentId));
}
