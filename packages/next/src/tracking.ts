/**
 * Exposure tracking — POSTs a "lead" (the impression) to crobot's existing
 * `/api/leads` endpoint, the SAME payload the v2 pixel sends, so experiment
 * results populate identically whether a visitor hits the middleware or the
 * pixel. crobot dedups by `(experiment_id, uuid)`, so a re-POST is harmless.
 *
 * Fire-and-forget: the returned promise never rejects. The caller passes it to
 * `event.waitUntil()` so it completes even after a redirect response is sent.
 *
 * page_view-goal conversions could also be emitted server-side here; click and
 * custom-event conversions are inherently client-side (the co-shipped pixel).
 */

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
