/**
 * Legacy HTTP calls that mirror 3.6's outbound requests to crobot endpoints.
 * These run alongside the new /track pipeline (additive, not a replacement).
 *
 * All three functions read domain + headers from window.Analytica, which is
 * installed by the legacy module on hydration. If Analytica is missing the
 * calls are silently skipped so SSR / preview environments aren't broken.
 */

import { publishLeadSent } from './legacy/index.ts';

/**
 * POST /api/leads — fires on variation_applied (once per experiment per session).
 * Dedup is via Analytica.sent[experimentId]; the flag is also mirrored by
 * publishLeadSent so customer code reading Analytica.sent sees the right value.
 */
export async function postLead(
  experimentId: number,
  variationId: number,
  visitorId: string,
): Promise<void> {
  const a = window.Analytica;
  if (!a) return;
  if (a.sent[experimentId]) return;
  await fetch(`${a.domain}/api/leads`, {
    method: 'POST',
    keepalive: true,
    headers: a.headers,
    body: JSON.stringify({ experiment: experimentId, variation: variationId, visitor: visitorId }),
  });
  publishLeadSent(experimentId);
}

/**
 * POST /api/leads/convert — fires on goal trigger.
 * Skipped when visitorId is null (cookie not yet set — can't attribute the conversion).
 */
export async function postLeadConvert(
  experimentId: number,
  goalId: number,
  visitorId: string | null,
): Promise<void> {
  const a = window.Analytica;
  if (!a || !visitorId) return;
  await fetch(`${a.domain}/api/leads/convert`, {
    method: 'POST',
    keepalive: true,
    headers: a.headers,
    body: JSON.stringify({ experiment: experimentId, goal: goalId, visitor: visitorId }),
  });
}

/**
 * GET /api/pixel?... — forwards Shopify Custom Pixel event data to crobot.
 * The receive side (window message listener) lives in the Shopify integration
 * module; this function only handles the outbound HTTP leg.
 */
export function postPixel(params: Record<string, string>): void {
  const a = window.Analytica;
  if (!a?.domain) return;
  const qs = new URLSearchParams(params).toString();
  void fetch(`${a.domain}/api/pixel?${qs}`, {
    method: 'GET',
    keepalive: true,
  });
}
