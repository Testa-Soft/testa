/**
 * PRD-006 experiment sessions (§1.3, §5.3), v2 experiments only.
 *
 * The pixel owns attribution: an exposure starts an experiment session for
 * (visitor, experiment) with a 60-minute SLIDING timeout — every event sent
 * pushes it to now + 3600. Every event carries the experiments whose session is
 * active (`exp`); with none active, the caller drops the event.
 *
 * State lives in the packed `_testa_exp` cookie (fields 4–6: sessionExp,
 * sessionStart, sessionIdx), shared with `@testa-soft/next`. The in-memory
 * overlay is authoritative; cookie writes are throttled to ≤ 1 per 30 s, plus
 * immediately when a session starts and on `pagehide`.
 */
import type { ExpSession } from '@testa-platform/shared-types';
import * as cookies from '../cookies.ts';

export const EXP_SESSION_TTL_SEC = 3600;
export const COOKIE_WRITE_THROTTLE_MS = 30_000;
/** Values above this in `sessionExp` are legacy millisecond last-touch stamps. */
const MS_THRESHOLD = 1e11;

export interface ExpSessionState {
  variation: number;
  /** Epoch seconds; the session is active while now < sessionExp. */
  sessionExp: number;
  /** Epoch seconds the current session began; 0 = none. */
  sessionStart: number;
  /** 1 for the first session, +1 per new session. */
  sessionIdx: number;
}

let _overlay = new Map<number, ExpSessionState>();
let _lastWriteMs = 0;
let _timer: ReturnType<typeof setTimeout> | null = null;
let _pagehideInstalled = false;

const toSec = (ms: number): number => Math.floor(ms / 1000);

/** Legacy pixels stored last-touch ms in `sessionExp`: convert to a seconds expiry. */
export function normalizeExpiry(raw: number): number {
  return raw > MS_THRESHOLD ? Math.floor(raw / 1000) + EXP_SESSION_TTL_SEC : raw;
}

function fromCookie(experimentId: number): ExpSessionState | null {
  try {
    const entry = cookies.readPacked().get(experimentId);
    if (!entry || entry.excluded || entry.variation < 0) return null;
    return {
      variation: entry.variation,
      sessionExp: normalizeExpiry(entry.sessionExp),
      sessionStart: entry.sessionStart ?? 0,
      sessionIdx: entry.sessionIdx ?? 0,
    };
  } catch {
    return null;
  }
}

export function readSession(experimentId: number): ExpSessionState | null {
  return _overlay.get(experimentId) ?? fromCookie(experimentId);
}

export const isActive = (s: ExpSessionState | null, nowMs: number): s is ExpSessionState =>
  s !== null && s.sessionStart > 0 && toSec(nowMs) < s.sessionExp;

/** Persist the overlay's session fields onto the matching cookie entries now. */
export function flush(nowMs: number = Date.now()): void {
  if (_timer !== null) {
    clearTimeout(_timer);
    _timer = null;
  }
  try {
    const map = cookies.readPacked();
    let changed = false;
    for (const [id, s] of _overlay) {
      const entry = map.get(id);
      if (!entry || entry.variation !== s.variation) continue;
      map.set(id, {
        ...entry,
        sessionExp: s.sessionExp,
        sessionStart: s.sessionStart,
        sessionIdx: s.sessionIdx,
      });
      changed = true;
    }
    if (changed) cookies.writePacked(map);
  } catch {
    // Blocked cookies must never break tracking; the overlay stays authoritative.
  }
  _lastWriteMs = nowMs;
}

function scheduleWrite(nowMs: number): void {
  const wait = COOKIE_WRITE_THROTTLE_MS - (nowMs - _lastWriteMs);
  if (wait <= 0) {
    flush(nowMs);
    return;
  }
  if (_timer === null) _timer = setTimeout(() => flush(Date.now()), wait);
}

function installPagehideFlush(): void {
  if (_pagehideInstalled || typeof addEventListener !== 'function') return;
  _pagehideInstalled = true;
  addEventListener('pagehide', () => flush(Date.now()));
}

/**
 * Called for an assigned, still-active v2 experiment on every page load / SPA
 * navigation (PRD §6.1 re-init). Starts a new session (sessionStart = now,
 * sessionIdx + 1) when none is active; otherwise leaves it as is.
 */
export function ensureSession(
  experimentId: number,
  variation: number,
  nowMs: number,
): { started: boolean; session: ExpSessionState } {
  installPagehideFlush();
  const current = readSession(experimentId);
  if (isActive(current, nowMs) && current.variation === variation) {
    return { started: false, session: current };
  }
  const nowSec = toSec(nowMs);
  const session: ExpSessionState = {
    variation,
    sessionStart: nowSec,
    sessionIdx: (current?.sessionIdx ?? 0) + 1,
    sessionExp: nowSec + EXP_SESSION_TTL_SEC,
  };
  _overlay.set(experimentId, session);
  flush(nowMs);
  return { started: true, session };
}

/** `exp` tuples for the given v2 experiments whose session is active at `nowMs`. */
export function activeExp(v2Ids: Iterable<number>, nowMs: number): ExpSession[] {
  const out: ExpSession[] = [];
  for (const id of v2Ids) {
    const s = readSession(id);
    if (isActive(s, nowMs)) out.push([id, s.variation, s.sessionStart, s.sessionIdx]);
  }
  return out;
}

/** Slide every session in `exp` to now + 3600 (called when an event is sent). */
export function touch(exp: readonly ExpSession[], nowMs: number): void {
  if (exp.length === 0) return;
  const expires = toSec(nowMs) + EXP_SESSION_TTL_SEC;
  for (const [id] of exp) {
    const s = readSession(id);
    if (s) _overlay.set(id, { ...s, sessionExp: Math.max(s.sessionExp, expires) });
  }
  scheduleWrite(nowMs);
}

export function __resetForTests(): void {
  if (_timer !== null) clearTimeout(_timer);
  _timer = null;
  _overlay = new Map();
  _lastWriteMs = 0;
}
