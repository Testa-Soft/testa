/**
 * Legacy HTTP calls — mirrors the three network calls 3.6 makes to the crobot
 * backend so MySQL-backed dashboards keep working through the 4.0 cutover.
 *
 * Reference: `docs/reference/legacy-pixel-mapping.md` (Legacy HTTP calls section).
 *
 * NOTE: Body shapes need verification against
 * `crobot/resources/js/integration/3.6/script.js` — the LeadController
 * validates strictly. The structures here match the task-file sketch; a human
 * reviewer should confirm field names before merging.
 *
 * Lifecycle wiring:
 *   postLead          — called from lifecycle.ts after `variation_applied`
 *   postLeadConvert   — called from experiments/goals.ts on any goal match
 *   postPixel         — called by Shopify message handler (wiring TBD per 3.6)
 */

function getDomain(): string {
  return window.Analytica?.domain ?? '';
}

function getHeaders(): Record<string, string> {
  return (
    window.Analytica?.headers ?? { 'Content-Type': 'application/json', Accept: 'application/json' }
  );
}

/**
 * POST /api/leads — fire once per (experimentId, session) when a variation is
 * applied. Deduped via `Analytica.sent[experimentId]` flag (3.6 parity).
 *
 * Body shape: `{ experiment, variation, visitor }`.
 * NOTE: verify against crobot 3.6 LeadController for any additional fields.
 */
export function postLead(experimentId: number, variationId: number, visitorId: string): void {
  const sent = window.Analytica?.sent;
  if (!sent) return;
  if (sent[experimentId]) return;

  const domain = getDomain();
  if (!domain) return;

  sent[experimentId] = 1;
  void fetch(`${domain}/api/leads`, {
    method: 'POST',
    keepalive: true,
    headers: getHeaders(),
    body: JSON.stringify({
      experiment: experimentId,
      variation: variationId,
      visitor: visitorId,
    }),
  });
}

/**
 * POST /api/leads/convert — fire when a goal is triggered.
 *
 * Body shape: `{ experiment, goal, ...data }`.
 * NOTE: verify against crobot 3.6 endpoint for any additional required fields.
 */
export function postLeadConvert(
  experimentId: number,
  goalId: number,
  data?: Record<string, unknown>,
): void {
  const domain = getDomain();
  if (!domain) return;

  void fetch(`${domain}/api/leads/convert`, {
    method: 'POST',
    keepalive: true,
    headers: getHeaders(),
    body: JSON.stringify({
      experiment: experimentId,
      goal: goalId,
      ...(data ?? {}),
    }),
  });
}

/**
 * GET /api/pixel?... — forward a Shopify Custom Pixel event to the backend.
 *
 * Called by the Shopify event handler when the host page dispatches a Shopify
 * web-pixel message. This function itself is pure; the `message` listener
 * wiring lives in the caller.
 *
 * NOTE: verify query-param names against crobot 3.6 `/api/pixel` handler.
 */
export function postPixel(eventName: string, data: Record<string, string>): void {
  const domain = getDomain();
  if (!domain) return;

  let url: URL;
  try {
    url = new URL(`${domain}/api/pixel`);
  } catch {
    return;
  }
  url.searchParams.set('event', eventName);
  for (const [k, v] of Object.entries(data)) {
    url.searchParams.set(k, v);
  }
  void fetch(url.toString(), { keepalive: true });
}
