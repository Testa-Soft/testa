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
}

/** POST an exposure to `{trackingHost}/api/leads`. Never throws. */
export function emitExposure(trackingHost: string, payload: ExposurePayload): Promise<void> {
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
