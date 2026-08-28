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

/** The visitor's own request context, forwarded with a server-side exposure. */
export interface ExposureContext {
  /** The VISITOR's user agent — see the note in `emitExposure`. */
  userAgent?: string | null;
  /** The VISITOR's IP, as the proxy saw it. */
  clientIp?: string | null;
}

/**
 * POST an exposure to `{trackingHost}/api/leads`. Never throws.
 *
 * The visitor's UA and IP are forwarded because this request is made BY THE
 * SERVER: without them every server-decided exposure is recorded against the
 * edge runtime's own user agent (`Next.js Middleware`) and the deployment's
 * egress IP. Every such row then looks like the same visitor on the same
 * machine, which makes device and geo reporting wrong — and makes non-browser
 * traffic impossible to spot, even though it announces itself clearly: a client
 * that ignores `Set-Cookie` mints a fresh visitor on every single request.
 */
export function emitExposure(
  trackingHost: string,
  payload: ExposurePayload,
  context: ExposureContext = {},
): Promise<void> {
  const url = `${trackingHost.replace(/\/+$/, '')}/api/leads`;
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...(context.userAgent ? { 'user-agent': context.userAgent } : {}),
      ...(context.clientIp ? { 'x-forwarded-for': context.clientIp } : {}),
    },
    body: JSON.stringify(payload),
    keepalive: true,
  }).then(
    () => undefined,
    () => undefined,
  );
}
