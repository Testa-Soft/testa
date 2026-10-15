/**
 * Codec for the consolidated `_testa_exp` cookie (task 3.16,
 * [[decision_experiment_storage_model]]).
 *
 * ONE cookie holds all experiment state as a compact positional string, cookie-
 * safe with NO base64:
 *
 *   `expId.variation.excluded.sessionExp[.sessionStart.sessionIdx]` per
 *   experiment, `~` between experiments
 *   e.g. `101.2.0.1760437200.1760433600.2~102.1.1.1720450500`
 *
 * Fields:
 *   - expId      — experiment_id
 *   - variation  — assigned variation_id (or -1 when excluded)
 *   - excluded   — 1 if the visitor is excluded (traffic allocation / targeting),
 *                  else 0. Exclusion PERSISTS: it's a point-in-time decision over
 *                  ephemeral inputs and is not re-derivable.
 *   - sessionExp — epoch SECONDS when the experiment session window expires
 *                  (0 when unused). PRD-006: last activity + 3600 (sliding).
 *   - sessionStart — PRD-006 (v2 experiments): epoch SECONDS the current
 *                  experiment session began; 0 = no active session.
 *   - sessionIdx — PRD-006: the visitor's session number in this experiment
 *                  (1, 2, …), +1 per new experiment session.
 *
 * Backward compatible both ways: 4-field segments (older writers) parse with
 * sessionStart = 0 / sessionIdx = 0; 5-field segments with sessionIdx = 1 when
 * a session is active (sessionStart > 0), else 0. Entries without session
 * fields serialize as 4 fields, and older readers ignore fields 5–6.
 *
 * Malformed segments are skipped rather than throwing — a corrupt cookie must
 * degrade to "no assignment", never crash the middleware.
 */

export const EXCLUDED_VARIATION_ID = -1;

/**
 * Sentinel variation for "targeting PASSED, cached eligible, but not yet on the
 * experiment page / not yet bucketed". Lets a first-touch targeting decision be
 * cached (crobot 3.3.3 caches `_testa_excl=0`) so a UTM on the landing page
 * keeps the visitor eligible on a later, UTM-less page. Never a real variation.
 */
export const ELIGIBLE_PENDING_VARIATION_ID = -2;

export interface ExpState {
  variation: number;
  excluded: boolean;
  sessionExp: number;
  /** PRD-006 experiment-session start (epoch s); absent/0 = no active session. */
  sessionStart?: number;
  /** PRD-006 experiment-session number (1-based); absent/0 = none yet. */
  sessionIdx?: number;
}

/** The PRD-006 session fields of an entry, for writers that must preserve them. */
export function sessionFieldsOf(
  state: ExpState | undefined,
): Pick<ExpState, 'sessionStart' | 'sessionIdx'> {
  if (!state) return {};
  return {
    ...(state.sessionStart ? { sessionStart: state.sessionStart } : {}),
    ...(state.sessionIdx ? { sessionIdx: state.sessionIdx } : {}),
  };
}

export type PackedExpMap = Map<number, ExpState>;

const EXPERIMENT_SEP = '~';
const FIELD_SEP = '.';

function toFiniteInt(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** Parse the raw cookie value into a map keyed by experiment_id. */
export function parsePacked(raw: string | null): PackedExpMap {
  const map: PackedExpMap = new Map();
  if (!raw) return map;

  for (const segment of raw.split(EXPERIMENT_SEP)) {
    if (!segment) continue;
    const parts = segment.split(FIELD_SEP);
    const expId = toFiniteInt(parts[0]);
    const variation = toFiniteInt(parts[1]);
    if (expId === null || variation === null) continue;
    const excluded = parts[2] === '1';
    const sessionExp = toFiniteInt(parts[3]) ?? 0;
    const sessionStart = Math.max(0, toFiniteInt(parts[4]) ?? 0);
    const sessionIdx =
      parts.length >= 6 ? Math.max(0, toFiniteInt(parts[5]) ?? 0) : sessionStart > 0 ? 1 : 0;
    map.set(expId, {
      variation,
      excluded,
      sessionExp,
      ...(sessionStart > 0 ? { sessionStart } : {}),
      ...(sessionIdx > 0 ? { sessionIdx } : {}),
    });
  }

  return map;
}

/** Serialize the map back into the cookie value (experiment_id-sorted for stability). */
export function serializePacked(map: PackedExpMap): string {
  const ids = [...map.keys()].sort((a, b) => a - b);
  const segments: string[] = [];
  for (const id of ids) {
    const s = map.get(id);
    if (!s) continue;
    const fields = [id, s.variation, s.excluded ? 1 : 0, Math.trunc(s.sessionExp)];
    const start = Math.trunc(s.sessionStart ?? 0);
    const idx = Math.trunc(s.sessionIdx ?? 0);
    if (start > 0 || idx > 0) fields.push(start, idx);
    segments.push(fields.join(FIELD_SEP));
  }
  return segments.join(EXPERIMENT_SEP);
}
