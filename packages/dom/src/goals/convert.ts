/**
 * Legacy conversion transport — POST to crobot's `/api/leads/convert`, the
 * SAME payload the 3.3.3 pixel sends (`createConversion`), so goal completions
 * populate crobot results identically whether they come from the legacy pixel
 * or the SDK. crobot dedups server-side (each goal counts once per visitor);
 * the per-load guard here only trims obvious same-page repeats.
 *
 * Fire-and-forget: never throws, never rejects — a conversion POST must not
 * break the host app.
 */

export interface LegacyConversionPayload {
  /** crobot goals.id (GoalConfig.goal_id). */
  goal_id: number;
  /** Goal action (URL pattern / selector / event name) — legacy body field. */
  action: string;
  /** `_testa_uuid`. */
  lead_uuid: string;
  /** Assigned variation IDENTIFIER (0 = control). */
  variation: number;
  /** Custom-event payload; empty for page_view/click. */
  data?: Record<string, unknown>;
}

// Once-per-page-load guard per (goal, experiment-agnostic goal id): a soft-nav
// re-register or repeat click must not re-POST within the same load. Reset on
// a full reload (module state), mirrors events/bus.ts `appliedThisLoad`.
const sentThisLoad = new Set<number>();

/** POST a conversion to `{trackingHost}/api/leads/convert`. Never throws. */
export function emitLegacyConversion(
  trackingHost: string,
  payload: LegacyConversionPayload,
): Promise<void> {
  if (!payload.lead_uuid) return Promise.resolve();
  if (sentThisLoad.has(payload.goal_id)) return Promise.resolve();
  sentThisLoad.add(payload.goal_id);

  const url = `${trackingHost.replace(/\/+$/, '')}/api/leads/convert`;
  try {
    return fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ data: {}, ...payload }),
      keepalive: true,
    }).then(
      () => undefined,
      () => undefined,
    );
  } catch {
    return Promise.resolve();
  }
}

/** Test hook — clear the once-per-load guard. */
export function resetConversionGuard(): void {
  sentThisLoad.clear();
}
