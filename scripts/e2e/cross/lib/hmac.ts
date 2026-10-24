/**
 * The two HMAC schemes on the boundary:
 *   - edge → collector ingest: hex(HMAC-SHA256(secret, body)) in `x-edge-signature`
 *     (docs/reference/hmac-protocol.md)
 *   - platform → crobot webhooks: `X-Testa-Signature: sha256=<hex(HMAC(secret, ts + "." + body))>`
 *     with `X-Testa-Timestamp` (PRD-006 §3.2, crobot PRD §4 VerifyAnalyticsWebhook)
 */

import { createHmac } from 'node:crypto';

export function signIngest(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

export interface WebhookHeaders {
  readonly 'x-testa-timestamp': string;
  readonly 'x-testa-signature': string;
}

export function signWebhook(body: string, secret: string, timestampSec: number): WebhookHeaders {
  const ts = String(timestampSec);
  const mac = createHmac('sha256', secret).update(`${ts}.${body}`, 'utf8').digest('hex');
  return { 'x-testa-timestamp': ts, 'x-testa-signature': `sha256=${mac}` };
}
