import type { EnrichedEvent, PixelEvent } from '@testa-platform/shared-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BatchBuffer, FLUSH_AT_COUNT } from '../batch.ts';
import app from '../index.ts';
import { signHmacSha256 } from '../ingest.ts';
import type { Env } from '../types.ts';

// ─── constants ──────────────────────────────────────────────────────────────

const SECRET = 'integration-test-shared-secret-32';
const COLLECTOR_ORIGIN = 'https://collector.test';

// ─── helpers ────────────────────────────────────────────────────────────────

function makeState(): DurableObjectState {
  let alarm: number | null = null;
  const storage = {
    getAlarm: async () => alarm,
    setAlarm: async (n: number | Date) => {
      alarm = typeof n === 'number' ? n : n.getTime();
    },
    deleteAlarm: async () => {
      alarm = null;
    },
  } as unknown as DurableObjectStorage;
  return { storage } as unknown as DurableObjectState;
}

function makeEvent(i: number, overrides: Partial<PixelEvent> = {}): PixelEvent {
  return {
    event_id: `00000000-0000-7000-8000-${String(i).padStart(12, '0')}`,
    event_name: 'page_view',
    client_ts: 1_700_000_000_000,
    project_id: 42,
    visitor_id: 'aaaabbbbcccc',
    session_id: 'sess-integration',
    url: 'https://customer.example/',
    consent_state: 'granted',
    tracker_version: '4.0.0',
    viewport_w: 1280,
    viewport_h: 720,
    ...overrides,
  };
}

// Env for the BatchBuffer itself — only needs HMAC fields.
const BUF_ENV: Env = {
  KV_PROJECT_CONFIG: {} as KVNamespace,
  KV_INTEGRATION_BUNDLES: {} as KVNamespace,
  BATCH_BUFFER: {} as DurableObjectNamespace,
  INGEST_SHARED_SECRET: SECRET,
  INGEST_ORIGIN_URL: COLLECTOR_ORIGIN,
  COOKIE_FALLBACK_DOMAIN: '.testa.com',
  VISITOR_ID_SALT: 'salt',
  ENVIRONMENT: 'test',
};

// ─── per-test state ──────────────────────────────────────────────────────────

let buf: BatchBuffer;
let fetchMock: ReturnType<typeof vi.fn>;
const realFetch = globalThis.fetch;

/** App env whose DO namespace routes stub.fetch() calls through the real buf. */
function makeAppEnv(overrides: Partial<Env> = {}): Env {
  return {
    KV_PROJECT_CONFIG: { get: async () => null } as unknown as KVNamespace,
    KV_INTEGRATION_BUNDLES: {} as KVNamespace,
    BATCH_BUFFER: {
      idFromName: (name: string) => ({ toString: () => name }) as unknown as DurableObjectId,
      get: () =>
        ({
          fetch: (input: RequestInfo | URL, init?: RequestInit) => {
            const req = input instanceof Request ? input : new Request(input as string, init);
            return buf.fetch(req);
          },
        }) as unknown as DurableObjectStub,
    } as unknown as DurableObjectNamespace,
    INGEST_SHARED_SECRET: SECRET,
    INGEST_ORIGIN_URL: COLLECTOR_ORIGIN,
    COOKIE_FALLBACK_DOMAIN: '.testa.com',
    VISITOR_ID_SALT: 'salt',
    ENVIRONMENT: 'test',
    ...overrides,
  };
}

beforeEach(() => {
  buf = new BatchBuffer(makeState(), BUF_ENV);
  fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  globalThis.fetch = fetchMock as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

// ─── tests ──────────────────────────────────────────────────────────────────

describe('Edge integration — /track → BatchBuffer → collector', () => {
  it('50 events trigger an immediate flush with a valid HMAC-signed batch', async () => {
    const env = makeAppEnv();

    for (let i = 0; i < FLUSH_AT_COUNT; i++) {
      const res = await app.fetch(
        new Request('https://customer.example/track', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify([makeEvent(i)]),
        }),
        env,
      );
      expect(res.status).toBe(204);
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`${COLLECTOR_ORIGIN}/_ingest`);

    const body = (init as RequestInit).body as string;
    const sentSig = ((init as RequestInit).headers as Record<string, string>)['x-edge-signature'];
    const expectedSig = await signHmacSha256(body, SECRET);
    expect(sentSig).toBe(expectedSig);

    const parsed = JSON.parse(body) as { signed_at: number; events: EnrichedEvent[] };
    expect(parsed.events).toHaveLength(FLUSH_AT_COUNT);
    expect(parsed.signed_at).toBeGreaterThan(0);
  });

  it('5 events flush when alarm() fires', async () => {
    const env = makeAppEnv();

    for (let i = 0; i < 5; i++) {
      await app.fetch(
        new Request('https://customer.example/track', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify([makeEvent(i)]),
        }),
        env,
      );
    }

    expect(fetchMock).not.toHaveBeenCalled();

    await buf.alarm();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const parsed = JSON.parse((init as RequestInit).body as string) as {
      events: EnrichedEvent[];
    };
    expect(parsed.events).toHaveLength(5);
  });

  it('verifiedBot=true → 204 response, no collector POST', async () => {
    const env = makeAppEnv();
    const request = new Request('https://customer.example/track', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([makeEvent(1)]),
    });
    Object.defineProperty(request, 'cf', {
      value: { botManagement: { verifiedBot: true } },
      configurable: true,
    });

    const res = await app.fetch(request, env);
    expect(res.status).toBe(204);

    await buf.alarm();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('GET /projects/foo.js → 200 + cfPrefill block + Set-Cookie', async () => {
    const config = {
      project_id: 42,
      slug: 'foo',
      integration_version: '4.0',
      consent_mode: 'aware',
      experiments: [],
      published_at: '2026-05-07T00:00:00.000Z',
      config_hash: 'abc123def456',
    };
    const bundle = '/* pixel 4.0 */ console.log("loaded");';
    const kvGet = vi.fn(async (key: string) => {
      if (key === 'project_config:foo') return JSON.stringify(config);
      if (key === 'integration_bundle:4.0') return bundle;
      return null;
    });
    const env = makeAppEnv({
      KV_PROJECT_CONFIG: { get: kvGet } as unknown as KVNamespace,
      KV_INTEGRATION_BUNDLES: { get: kvGet } as unknown as KVNamespace,
    });

    const res = await app.fetch(new Request('https://track.testa.com/projects/foo.js'), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/javascript');
    expect(res.headers.get('set-cookie')).toMatch(/_testa_uuid=/);

    const body = await res.text();
    expect(body).toContain('window.cfPrefill');
    expect(body).toContain('"project_id":42');
    expect(body).toContain(bundle);
  });

  it('heuristic bot traffic tagged is_bot=1 but still forwarded', async () => {
    const env = makeAppEnv();
    await app.fetch(
      new Request('https://customer.example/track', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'HeadlessChrome/120.0',
        },
        body: JSON.stringify([makeEvent(1)]),
      }),
      env,
    );
    await buf.alarm();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const parsed = JSON.parse((init as RequestInit).body as string) as {
      events: EnrichedEvent[];
    };
    expect(parsed.events[0]?.is_bot).toBe(1);
  });
});
