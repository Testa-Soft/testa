/**
 * Persisted "shield hint" — the smartness behind auto-shielding a pure SPA.
 *
 * The dilemma: on a fresh page load we must decide whether to raise the
 * anti-flicker shield BEFORE the config has arrived (the whole point of a shield
 * is to hide content before first paint — we can't wait for a network round
 * trip). So we can't ask the just-loaded config yet; instead we remember what
 * the LAST successful config load told us and act on that:
 *
 *   - hint === null  → first-ever visit (or storage unavailable). Shield
 *                      defensively: a brief hidden page beats a control→variant
 *                      flash.
 *   - hint === false → last time the project had nothing to hide (no active
 *                      experiment carried any change). Skip the shield entirely,
 *                      so a project that isn't testing never flashes blank.
 *   - hint === true  → last time there was something to hide. Shield.
 *
 * The hint is refreshed on every successful config load, so a project that turns
 * experiments on or off self-corrects within a single subsequent visit.
 */

import type { ProjectConfig } from '@testa-platform/shared-types';

/** localStorage key holding the persisted shield hint (`'1'` → true, `'0'` → false). */
export const SHIELD_HINT_KEY = '__testa_shield_hint';

/**
 * Read the persisted hint. `true`/`false` when a value was stored, `null` when
 * absent or unreadable (SSR, privacy mode, storage throwing on access).
 */
export function readShieldHint(): boolean | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(SHIELD_HINT_KEY);
    if (raw === '1') return true;
    if (raw === '0') return false;
    return null;
  } catch {
    // Access itself can throw (Safari private mode, sandboxed iframe) — the hint
    // is an optimisation, so treat any failure as "no hint".
    return null;
  }
}

/** Persist the hint. Best-effort — never throws (storage may be unavailable). */
export function writeShieldHint(value: boolean): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(SHIELD_HINT_KEY, value ? '1' : '0');
  } catch {
    // Storage unavailable (SSR, privacy mode, quota) — the hint is never a
    // correctness requirement, so swallow.
  }
}

/**
 * Does this config warrant a shield? True when ANY active experiment has ANY
 * variation carrying at least one change — DOM change OR redirect.
 *
 * Redirects count because in a pure SPA the split-URL redirect is client-side
 * (`location.replace`): an unshielded load flashes the control page before
 * navigating away, so the shield staying up through the redirect is what hides
 * that. Experiments with `status !== 'active'` or with no changes in any
 * variation don't warrant a shield.
 */
export function configNeedsShield(config: ProjectConfig): boolean {
  return config.experiments.some(
    (experiment) =>
      experiment.status === 'active' &&
      experiment.variations.some((variation) => variation.changes.length > 0),
  );
}
