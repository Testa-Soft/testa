/**
 * Codec for the consolidated `_testa_exp` cookie (task 3.16,
 * [[decision_experiment_storage_model]]).
 *
 * ONE cookie holds all experiment state as a compact positional string, cookie-
 * safe with NO base64:
 *
 *   `expId.variation.excluded.sessionExp` per experiment, `~` between experiments
 *   e.g. `101.2.0.1720450000~102.1.1.1720450500`
 *
 * Fields:
 *   - expId      — experiment_id
 *   - variation  — assigned variation_id (or -1 when excluded)
 *   - excluded   — 1 if the visitor is excluded (traffic allocation / targeting),
 *                  else 0. Exclusion PERSISTS: it's a point-in-time decision over
 *                  ephemeral inputs and is not re-derivable.
 *   - sessionExp — epoch SECONDS when the experiment session window expires
 *                  (0 when unused). Carried for format parity; the redirect MVP
 *                  does not read it.
 *
 * Malformed segments are skipped rather than throwing — a corrupt cookie must
 * degrade to "no assignment", never crash the middleware.
 */

export const EXCLUDED_VARIATION_ID = -1;

export interface ExpState {
  variation: number;
  excluded: boolean;
  sessionExp: number;
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
    map.set(expId, { variation, excluded, sessionExp });
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
    segments.push([id, s.variation, s.excluded ? 1 : 0, Math.trunc(s.sessionExp)].join(FIELD_SEP));
  }
  return segments.join(EXPERIMENT_SEP);
}
