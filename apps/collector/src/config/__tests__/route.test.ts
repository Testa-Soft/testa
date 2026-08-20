import { describe, expect, it } from 'bun:test';
import type { ProjectConfig } from '@testa-platform/shared-types';
import { Hono } from 'hono';
import { makeConfigGetHandler, makeConfigPutHandler } from '../route.ts';
import type { ConfigStore } from '../store.ts';

function memoryStore(): ConfigStore & { map: Map<string, ProjectConfig> } {
  const map = new Map<string, ProjectConfig>();
  return {
    map,
    put: async (projectId, config) => {
      map.set(projectId, config);
    },
    get: async (projectId) => map.get(projectId) ?? null,
  };
}

function buildApp(store: ConfigStore): Hono {
  const app = new Hono();
  const now = () => '2026-08-04T00:00:00.000Z';
  app.post('/api/v1/config/:projectId', makeConfigPutHandler({ store, now }));
  app.get('/api/v1/config/:projectId', makeConfigGetHandler({ store }));
  return app;
}

// The real `GET /projects/12345.json` shape, trimmed.
const SOURCE_PROJECT = {
  id: 2,
  name: 'Test',
  experiments: [
    {
      id: 531,
      url_match_type: 'exact',
      identifier: 339593,
      title: 'Pricing DEMO',
      traffic: 100,
      url: 'http://localhost:3100/pricing',
      type: 'split_url',
      status: 'active',
      variations: [
        { id: 1563, identifier: 0, traffic: 50, url_match_type: 'contains', changes: [] },
        {
          id: 1564,
          identifier: 1,
          traffic: 50,
          url_match_type: 'exact',
          changes: [{ url_match_type: 'exact', content: 'http://localhost:3100/pricing-v2' }],
        },
      ],
    },
  ],
};

const post = (app: Hono, id: string, body: unknown) =>
  app.fetch(
    new Request(`http://test.local/api/v1/config/${id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

const get = (app: Hono, id: string) =>
  app.fetch(new Request(`http://test.local/api/v1/config/${id}`));

describe('POST /api/v1/config/:projectId', () => {
  it('builds a ProjectConfig from upstream JSON and stores it', async () => {
    const store = memoryStore();
    const res = await post(buildApp(store), '12345', SOURCE_PROJECT);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, slug: '12345', experiments: 1 });

    const stored = store.map.get('12345');
    expect(stored?.experiments[0]?.experiment_id).toBe(339593);
    expect(stored?.experiments[0]?.variations[1]?.changes[0]).toMatchObject({
      type: 'redirect',
      from_url: 'http://localhost:3100/pricing',
      to_url: 'http://localhost:3100/pricing-v2',
    });
  });

  it('rejects a body that is not a project (422)', async () => {
    const res = await post(buildApp(memoryStore()), '12345', { nope: true });
    expect(res.status).toBe(422);
  });

  it('rejects invalid JSON (400)', async () => {
    const app = buildApp(memoryStore());
    const res = await app.fetch(
      new Request('http://test.local/api/v1/config/12345', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not json',
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe('GET /api/v1/config/:projectId', () => {
  it('serves a previously stored config', async () => {
    const store = memoryStore();
    const app = buildApp(store);
    await post(app, '12345', SOURCE_PROJECT);
    const res = await get(app, '12345');
    expect(res.status).toBe(200);
    const cfg = (await res.json()) as ProjectConfig;
    expect(cfg.slug).toBe('12345');
    expect(cfg.experiments).toHaveLength(1);
  });

  it('404s for an unknown project', async () => {
    const res = await get(buildApp(memoryStore()), 'unknown');
    expect(res.status).toBe(404);
  });

  it('serves a long shared-cache TTL (purge-on-publish invalidates) + short browser max-age', async () => {
    const store = memoryStore();
    const app = buildApp(store);
    await post(app, '12345', SOURCE_PROJECT);
    const res = await get(app, '12345');
    expect(res.headers.get('cache-control')).toBe(
      'public, max-age=60, s-maxage=600, stale-while-revalidate=1800',
    );
  });

  it('marks a 404 as no-store so the CDN never negative-caches a not-yet-published project', async () => {
    const res = await get(buildApp(memoryStore()), 'unknown');
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('POST /api/v1/config auth (write token)', () => {
  const authedApp = (store: ConfigStore): Hono => {
    const app = new Hono();
    app.post(
      '/api/v1/config/:projectId',
      makeConfigPutHandler({
        store,
        writeToken: 'secret-token-123',
        now: () => '2026-08-04T00:00:00.000Z',
      }),
    );
    return app;
  };

  const postWith = (app: Hono, auth?: string) =>
    app.fetch(
      new Request('http://test.local/api/v1/config/12345', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(auth ? { authorization: auth } : {}),
        },
        body: JSON.stringify(SOURCE_PROJECT),
      }),
    );

  it('rejects a request with no token (401)', async () => {
    expect((await postWith(authedApp(memoryStore()))).status).toBe(401);
  });

  it('rejects a wrong token (401)', async () => {
    expect((await postWith(authedApp(memoryStore()), 'Bearer nope')).status).toBe(401);
  });

  it('accepts the correct token (200)', async () => {
    expect((await postWith(authedApp(memoryStore()), 'Bearer secret-token-123')).status).toBe(200);
  });
});
