/**
 * PRD-006 experiment sessions (§1.3, §5.3) as pure functions over the packed
 * `_testa_exp` state, shared by the pixel and `@testa-soft/next` / react so
 * both surfaces count sessions the same way.
 *
 *   sessionExp   = last event + 3600 (epoch s); active while now < sessionExp
 *   sessionStart = when the current session began; 0 = no active session
 *   sessionIdx   = 1, 2, … — +1 per new session (returning = idx ≥ 2)
 *
 * Only assigned entries (a real variation, not excluded) carry sessions.
 */
import type { ExpSession } from '@testa-platform/shared-types';
import type { ExpState } from './packed-cookie.ts';

export const EXP_SESSION_TTL_SEC = 3600;
/** `sessionExp` values above this are legacy millisecond last-touch stamps (old pixels). */
export const LEGACY_MS_THRESHOLD = 1e11;

/** Legacy pixels stored last-touch ms in `sessionExp`: read it as a seconds expiry. */
export function normalizeExpiry(raw: number): number {
  return raw > LEGACY_MS_THRESHOLD ? Math.floor(raw / 1000) + EXP_SESSION_TTL_SEC : raw;
}

const assigned = (s: ExpState | undefined): s is ExpState => !!s && !s.excluded && s.variation >= 0;

/** Is the entry's PRD-006 session active at `nowSec`? */
export function isExpSessionActive(s: ExpState | undefined, nowSec: number): boolean {
  return assigned(s) && (s.sessionStart ?? 0) > 0 && nowSec < normalizeExpiry(s.sessionExp);
}

/**
 * Start a new session when none is active (PRD §6.1 re-init): sessionStart =
 * now, sessionIdx + 1, sessionExp = now + 3600. Returns the new state, or
 * `null` when the session is already active (nothing to change).
 */
export function startExpSessionIfNeeded(s: ExpState | undefined, nowSec: number): ExpState | null {
  if (!assigned(s) || isExpSessionActive(s, nowSec)) return null;
  return {
    ...s,
    sessionStart: nowSec,
    sessionIdx: (s.sessionIdx ?? 0) + 1,
    sessionExp: nowSec + EXP_SESSION_TTL_SEC,
  };
}

/** `exp` tuples for `ids` whose session is active (PRD §1.4). */
export function activeExpSessions(
  get: (id: number) => ExpState | undefined,
  ids: Iterable<number>,
  nowSec: number,
): ExpSession[] {
  const out: ExpSession[] = [];
  for (const id of ids) {
    const s = get(id);
    if (s && isExpSessionActive(s, nowSec))
      out.push([id, s.variation, s.sessionStart ?? 0, s.sessionIdx ?? 0]);
  }
  return out;
}

/** Slide an active session to now + 3600 (an event was sent). Never shortens. */
export function slideExpSession(s: ExpState, nowSec: number): ExpState {
  return {
    ...s,
    sessionExp: Math.max(normalizeExpiry(s.sessionExp), nowSec + EXP_SESSION_TTL_SEC),
  };
}
