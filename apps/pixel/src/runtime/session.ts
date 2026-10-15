/**
 * Visitor session id — one UUIDv4 per ~30 min of activity.
 *
 * The `_testa_sid` cookie holds the current session id with a sliding 30-min
 * TTL: every track() call refreshes the Max-Age so an active visitor never
 * times out, but 30 min of idle ends the session and the next track() mints
 * a new id.
 *
 * This is distinct from `_testa_ses_<expId>` cookies (per-experiment session
 * timestamps used for experiment-view counting) — the global session id is
 * what dashboards group events into "sessions" on.
 */

import { SECONDS_PER_HOUR, readValue, writeValue } from './storage.ts';

export const SESSION_ID_COOKIE = '_testa_sid';
const SESSION_TTL_SEC = SECONDS_PER_HOUR / 2;

/** Browsing-session count on the site (PRD-006 §5.3), informational only. */
export const VISIT_NUMBER_COOKIE = '_testa_vn';
const VISIT_NUMBER_TTL_SEC = 400 * 24 * SECONDS_PER_HOUR;

/** Current visit number (0 when unknown / storage blocked). */
export function readVisitNumber(): number {
  try {
    const n = Number(readValue(VISIT_NUMBER_COOKIE));
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function bumpVisitNumber(): void {
  try {
    writeValue(VISIT_NUMBER_COOKIE, String(readVisitNumber() + 1), {
      maxAgeSec: VISIT_NUMBER_TTL_SEC,
    });
  } catch {
    // Informational only; never break session minting.
  }
}

/**
 * Read the current session id, or mint one if absent. Always refreshes the
 * cookie's Max-Age so the session keeps sliding forward while the visitor
 * is active.
 */
export function getOrCreateSessionId(): string {
  const existing = readValue(SESSION_ID_COOKIE);
  if (existing && isUuid(existing)) {
    writeValue(SESSION_ID_COOKIE, existing, { maxAgeSec: SESSION_TTL_SEC });
    return existing;
  }
  const fresh = generateSessionId();
  writeValue(SESSION_ID_COOKIE, fresh, { maxAgeSec: SESSION_TTL_SEC });
  // A new browsing session starts: `_testa_vn` += 1 (not used for new vs
  // returning — that is the experiment sessionIdx, PRD §1.3a).
  bumpVisitNumber();
  return fresh;
}

function generateSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for ancient browsers — uniqueness, not cryptographic strength,
  // is what matters for session keys.
  const r = () =>
    Math.floor(Math.random() * 0xffff)
      .toString(16)
      .padStart(4, '0');
  return `${r()}${r()}-${r()}-4${r().slice(1)}-${r()}-${r()}${r()}${r()}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}
