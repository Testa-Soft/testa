/**
 * Exposure tracking — POSTs a "lead" (the impression) to crobot's existing
 * `/api/leads` endpoint, the SAME payload the pixel + `@testa-soft/next` send,
 * so experiment results populate identically across every surface. crobot dedups
 * by `(experiment_id, uuid)`, so a re-POST is harmless.
 *
 * Fire-and-forget: the returned promise never rejects. `keepalive` lets it
 * complete even when the SDK immediately triggers a client-side redirect.
 */

/** Default host for exposure/conversion tracking (crobot's `/api/leads`). */
export const DEFAULT_TRACKING_HOST = 'https://new.testa-soft.tech';

export interface ExposurePayload {
  /** crobot numeric project id (ProjectConfig.project_id). */
  project_id: number;
  /** Experiment IDENTIFIER (0-based, not the DB pk). */
  experiment: number;
  /** Variation IDENTIFIER (0-based). */
  variation: number;
  /** `_testa_uuid`. */
  uuid: string;
  title?: string;
  url: string;
  /**
   * WHERE this lead was created — which decider, on what kind of request.
   *
   * The same experiment is decided in several places (edge proxy on a document
   * load, edge proxy on a framework data fetch, the client engine on an initial
   * load, the client engine on a soft navigation), and until now a row in
   * `/api/leads` looked identical whichever produced it. That makes a counting
   * discrepancy unattributable: you can see that there are more leads than
   * visitors and not which path minted the extras.
   *
   * crobot ignores unknown fields, so this is inert until a column exists for
   * it; the same value also goes to `/log`, which records it today.
   */
  source?: string;
}

/**
 * Once-per-page-load guard, keyed by `(experiment, variation, uuid)` — mirrors
 * `dom/goals/convert.ts`. The client reports an exposure on every load rather
 * than only on fresh enrollment (3.3.3 pixel model): it is the only side that
 * can resolve the visitor id once a cookie stops sticking, and crobot dedups on
 * `(experiment_id, uuid)` so repeats collapse. This trims the obvious in-page
 * repeats — a soft-nav re-apply, a re-render — before they reach the network.
 */
const sentThisLoad = new Set<string>();

/** POST an exposure to `{trackingHost}/api/leads`. Never throws. */
export function emitExposure(trackingHost: string, payload: ExposurePayload): Promise<void> {
  if (!payload.uuid) return Promise.resolve();
  const key = `${payload.experiment}:${payload.variation}:${payload.uuid}`;
  if (sentThisLoad.has(key)) return Promise.resolve();
  sentThisLoad.add(key);

  const url = `${trackingHost.replace(/\/+$/, '')}/api/leads`;
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload),
    keepalive: true,
  }).then(
    () => undefined,
    () => undefined,
  );
}

/** Test hook — clear the once-per-load guard. */
export function resetExposureGuard(): void {
  sentThisLoad.clear();
}
