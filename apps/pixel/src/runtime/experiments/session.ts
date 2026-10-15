/**
 * PRD-006 experiment sessions in the pixel (§1.3, §5.3), v2 experiments only.
 *
 * The session rules themselves (60-min sliding timeout, sessionIdx + 1 per new
 * session, legacy ms values) live in `@testa-soft/experiment-core`
 * (`exp-session.ts`), shared with `@testa-soft/next`. This module adds the
 * pixel's storage policy: the in-memory overlay is authoritative; cookie
 * writes are throttled to ≤ 1 per 30 s, immediate when a session starts, and
 * flushed on `pagehide`.
 */
import type { ExpSession } from '@testa-platform/shared-types';
import {
  EXP_SESSION_TTL_SEC,
  type ExpState,
  activeExpSessions,
  isExpSessionActive,
  normalizeExpiry,
  slideExpSession,
  startExpSessionIfNeeded,
} from '@testa-soft/experiment-core';
import * as cookies from '../cookies.ts';

export { EXP_SESSION_TTL_SEC, normalizeExpiry };
export const COOKIE_WRITE_THROTTLE_MS = 30_000;

let _overlay = new Map<number, ExpState>();
let _lastWriteMs = 0;
let _timer: ReturnType<typeof setTimeout> | null = null;
let _pagehideInstalled = false;

const toSec = (ms: number): number => Math.floor(ms / 1000);

function fromCookie(experimentId: number): ExpState | undefined {
  try {
    return cookies.readPacked().get(experimentId);
  } catch {
    return undefined;
  }
}

export function readSession(experimentId: number): ExpState | undefined {
  return _overlay.get(experimentId) ?? fromCookie(experimentId);
}

export const isActive = (s: ExpState | undefined, nowMs: number): s is ExpState =>
  isExpSessionActive(s, toSec(nowMs));

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
        ...(s.sessionStart !== undefined ? { sessionStart: s.sessionStart } : {}),
        ...(s.sessionIdx !== undefined ? { sessionIdx: s.sessionIdx } : {}),
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
 * navigation (PRD §6.1 re-init): starts a new session when none is active.
 */
export function ensureSession(
  experimentId: number,
  variation: number,
  nowMs: number,
): { started: boolean; session: ExpState | undefined } {
  installPagehideFlush();
  const current = readSession(experimentId);
  // The caller just (re)confirmed this assignment; a cookie the pixel can't
  // read yet (or a different variation) still gets a fresh entry.
  const base: ExpState =
    current && current.variation === variation
      ? current
      : {
          variation,
          excluded: false,
          sessionExp: 0,
          ...(current?.sessionIdx ? { sessionIdx: current.sessionIdx } : {}),
        };
  const next = startExpSessionIfNeeded(base, toSec(nowMs));
  if (!next) return { started: false, session: current };
  _overlay.set(experimentId, next);
  flush(nowMs);
  return { started: true, session: next };
}

/** `exp` tuples for the given v2 experiments whose session is active at `nowMs`. */
export function activeExp(v2Ids: Iterable<number>, nowMs: number): ExpSession[] {
  return activeExpSessions(readSession, v2Ids, toSec(nowMs));
}

/** Slide every session in `exp` to now + 3600 (called when an event is sent). */
export function touch(exp: readonly ExpSession[], nowMs: number): void {
  if (exp.length === 0) return;
  for (const [id] of exp) {
    const s = readSession(id);
    if (s) _overlay.set(id, slideExpSession(s, toSec(nowMs)));
  }
  scheduleWrite(nowMs);
}

export function __resetForTests(): void {
  if (_timer !== null) clearTimeout(_timer);
  _timer = null;
  _overlay = new Map();
  _lastWriteMs = 0;
}
