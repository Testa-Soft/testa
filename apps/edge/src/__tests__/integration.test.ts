/**
 * Edge worker end-to-end integration test (task 2.8).
 *
 * Drives the REAL worker against miniflare's real bindings — the actual
 * BatchBuffer DurableObject and real KV — via `app.fetch(req, env)` with `env`
 * from `cloudflare:test`. The outbound collector POST is intercepted with
 * undici's `fetchMock`, so we assert the full path closes:
 *
 *   pixel POST /track → enrich → bot filter → DO batch (count OR alarm) →
 *   forwardBatch → HMAC-signed POST to {INGEST_ORIGIN_URL}/_ingest
 *
 * The captured batch is verified with an independent WebCrypto HMAC recompute
 * (the collector's `verify` lives on `node:crypto`, which the Workers test pool
 * can't import — so we recompute the SHA-256 hex here and compare, which is the
 * exact contract the collector checks; see docs/reference/hmac-protocol.md).
 *
 * Each test uses a distinct `project_id` so it maps to a distinct DO instance
 * (routing key = `project_id:visitor_bucket`), keeping the in-memory buffers
 * from leaking across tests.
 */

import { env, fetchMock } from 'cloudflare:test';
import type { ConsentState, PixelEvent, ProjectConfig } from '@testa-platform/shared-types';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import app from '../index.ts';

const COLLECTOR_ORIGIN = 'https://collector.test';

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => {
  fetchMock.assertNoPendingInterceptors();
});

// ─── helpers ────────────────────────────────────────────────────────────────

interface Captured {
  body: string;
  signature: string;
}

/** Intercept one collector POST, capturing its body + signature header. */
function interceptIngest(sink: Captured[]): void {
  fetchMock
    .get(COLLECTOR_ORIGIN)
    .intercept({ path: '/_ingest', method: 'POST' })
    .reply((opts) => {
      const headers = opts.headers as Record<string, string> | undefined;
      sink.push({
        body: opts.body as string,
        signature: headers?.['x-edge-signature'] ?? '',
      });
      return { statusCode: 204, data: '' };
    });
}

/** Recompute HMAC-SHA256 hex independently of the code under test. */
async function hmacHex(body: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function makeEvent(projectId: number, overrides: Partial<PixelEvent> = {}): PixelEvent {
  return {
    event_id: crypto.randomUUID(),
    event_name: 'page_view',
    client_ts: 1_700_000_000_000,
    project_id: projectId,
    visitor_id: 'aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee',
    session_id: 'sess-1',
    url: 'https://customer.example/landing',
    consent_state: 'granted' as ConsentState,
    tracker_version: '4.0.0',
    viewport_w: 1280,
    viewport_h: 720,
    ...overrides,
  };
}

async function postTrack(events: PixelEvent[], cf?: unknown): Promise<Response> {
  const req = new Request('https://customer.example/track', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(events),
  });
  if (cf !== undefined) Object.defineProperty(req, 'cf', { value: cf });
  return app.fetch(req, env);
}

/** Poll until the sink has `n` captured batches, or time out. */
async function waitForBatches(sink: Captured[], n: number, timeoutMs = 2500): Promise<void> {
  const step = 25;
  for (let waited = 0; waited < timeoutMs && sink.length < n; waited += step) {
    await new Promise((r) => setTimeout(r, step));
  }
}

// ─── tests ────────────────────────────────────────────────────────────────

describe('POST /track → collector (count-triggered flush)', () => {
  it('50 events land as one HMAC-signed batch of 50 the collector would accept', async () => {
    const captured: Captured[] = [];
    interceptIngest(captured);

    const events = Array.from({ length: 50 }, () => makeEvent(1042));
    const res = await postTrack(events);
    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie')).toMatch(/_testa_uuid=/);

    await waitForBatches(captured, 1);
    expect(captured).toHaveLength(1);

    const { body, signature } = captured[0] as Captured;
    // Contract: signature is the HMAC-SHA256 hex of the exact body.
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
    expect(signature).toBe(await hmacHex(body, env.INGEST_SHARED_SECRET));

    const batch = JSON.parse(body) as { signed_at: number; events: unknown[] };
    expect(typeof batch.signed_at).toBe('number');
    expect(batch.events).toHaveLength(50);
  });
});

describe('POST /track → collector (alarm-triggered flush)', () => {
  it('5 events flush via the 500ms alarm as one batch of 5', async () => {
    const captured: Captured[] = [];
    interceptIngest(captured);

    const events = Array.from({ length: 5 }, () => makeEvent(1043, { visitor_id: 'bb-visitor' }));
    const res = await postTrack(events);
    expect(res.status).toBe(204);

    await waitForBatches(captured, 1);
    expect(captured).toHaveLength(1);
    expect(JSON.parse((captured[0] as Captured).body).events).toHaveLength(5);
  });
});

describe('POST /track — verified bot', () => {
  it('drops the batch (204, no collector POST) on cf.botManagement.verifiedBot', async () => {
    // No intercept registered — with net-connect disabled, any outbound POST
    // would throw. A clean 204 with zero captures proves nothing was forwarded.
    const res = await postTrack([makeEvent(1044, { visitor_id: 'cc-bot' })], {
      botManagement: { verifiedBot: true },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie')).toMatch(/_testa_uuid=/);
    // Give any (erroneous) async forward a chance to happen before asserting.
    await new Promise((r) => setTimeout(r, 200));
  });
});

describe('GET /projects/:slug.js — real KV', () => {
  it('serves 200 with cfPrefill + Set-Cookie from seeded KV', async () => {
    const config: ProjectConfig = {
      project_id: 4200,
      slug: 'foo',
      integration_version: '4.0',
      consent_mode: 'aware',
      experiments: [],
      published_at: '2026-05-07T00:00:00.000Z',
      config_hash: 'abcdef123456',
    };
    const bundle = '/* loader+runtime 4.0 */ console.log("4.0");';
    await env.KV_PROJECT_CONFIG.put('project_config:foo', JSON.stringify(config));
    await env.KV_INTEGRATION_BUNDLES.put('integration_bundle:4.0', bundle);

    const res = await app.fetch(new Request('https://track.testa.com/projects/foo.js'), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/javascript');
    expect(res.headers.get('etag')).toBe(`"${config.config_hash}"`);
    expect(res.headers.get('set-cookie')).toMatch(/_testa_uuid=/);

    const text = await res.text();
    expect(text).toContain('window.cfPrefill');
    expect(text).toContain('"project_id":4200');
    expect(text).toContain(bundle);
  });
});
