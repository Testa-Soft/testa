/**
 * Optional crobot webhooks (PRD-006 §3.2): `summary-ready` / `query-ready`,
 * POSTed to `{CROBOT_WEBHOOK_URL}/api/webhooks/analytics/{event}` with
 * `X-Testa-Timestamp` and `X-Testa-Signature: sha256=HMAC(secret, ts + "." + body)`.
 * Retried on network errors / non-2xx with the configured backoff, then
 * dropped (crobot's poll catches up anyway).
 */
import { createHmac } from 'node:crypto';
import type { WebhookPayload } from '@testa-platform/shared-types';

export interface WebhookConfig {
  url: string;
  secret: string;
  retryDelaysSec: readonly number[];
}

export interface WebhookSender {
  send(payload: WebhookPayload): void;
  /** Resolves when every in-flight delivery has succeeded or been dropped. */
  drain(): Promise<void>;
}

export function sign(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function createWebhookSender(
  cfg: WebhookConfig,
  deps: { fetchFn?: typeof fetch; log?: (msg: string) => void } = {},
): WebhookSender {
  const fetchFn = deps.fetchFn ?? fetch;
  const log = deps.log ?? ((m: string) => console.warn(`[modeler] ${m}`));
  const inFlight = new Set<Promise<void>>();
  const base = cfg.url.replace(/\/+$/, '');

  async function deliver(payload: WebhookPayload): Promise<void> {
    const body = JSON.stringify(payload);
    const url = `${base}/api/webhooks/analytics/${payload.event}`;
    for (let attempt = 0; attempt <= cfg.retryDelaysSec.length; attempt++) {
      if (attempt > 0) await sleep((cfg.retryDelaysSec[attempt - 1] ?? 0) * 1000);
      const ts = String(Math.floor(Date.now() / 1000));
      try {
        const res = await fetchFn(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'X-Testa-Timestamp': ts,
            'X-Testa-Signature': sign(cfg.secret, ts, body),
          },
          body,
        });
        if (res.ok) return;
        log(`webhook ${payload.event} → ${res.status} (attempt ${attempt + 1})`);
      } catch (err) {
        log(`webhook ${payload.event} failed (attempt ${attempt + 1}): ${(err as Error).message}`);
      }
    }
    log(`webhook ${payload.event} dropped after ${cfg.retryDelaysSec.length + 1} attempts`);
  }

  return {
    send(payload) {
      const p = deliver(payload).finally(() => inFlight.delete(p));
      inFlight.add(p);
    },
    async drain() {
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },
  };
}

/** No-op sender when `CROBOT_WEBHOOK_URL` is empty. */
export const noWebhooks: WebhookSender = { send() {}, drain: async () => {} };
