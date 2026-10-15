/**
 * The sync API as mounted by the real collector app, over real HTTP. Only
 * checks that need no storage (auth, request validation that fails before any
 * I/O, route wiring); the storage-backed behaviour is in sync.integration.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Server } from 'bun';
import { config } from '../../config.ts';
import app from '../../index.ts';

let server: Server;
let base: string;
const auth = { 'X-Service-Token': config.serviceToken, 'content-type': 'application/json' };

beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: app.fetch });
  base = `http://localhost:${server.port}`;
});
afterAll(() => {
  server.stop(true);
});

const ROUTES: [string, string][] = [
  ['PUT', '/api/v1/experiments/1717/subscription'],
  ['DELETE', '/api/v1/experiments/1717/subscription?project_id=42'],
  ['GET', '/api/v1/experiments/1717/daily-summary?project_id=42&since_run_id=r_1'],
  ['POST', '/api/v1/experiments/1717/queries'],
  ['GET', `/api/v1/experiments/1717/queries/${'a'.repeat(64)}?project_id=42`],
];

describe('sync API wiring (real app)', () => {
  for (const [method, path] of ROUTES) {
    it(`${method} ${path} → 401 unauthorized without the service token`, async () => {
      const res = await fetch(base + path, { method });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    });
  }

  it.each([
    [{ project_id: 42, status: 'paused' }, 400, { error: 'invalid_status', field: 'status' }],
    ['not json', 400, { error: 'invalid_status', field: 'body' }],
    [
      {
        project_id: 42,
        status: 'running',
        from: '2026-10-05',
        to: '2026-10-01',
        report_currency: 'EUR',
        metrics: ['purchase'],
      },
      400,
      { error: 'invalid_range', field: 'from' },
    ],
    [
      {
        project_id: 42,
        status: 'running',
        from: '2026-10-01',
        to: null,
        report_currency: 'euro',
        metrics: ['purchase'],
      },
      400,
      { error: 'invalid_currency', field: 'report_currency' },
    ],
    [
      {
        project_id: 42,
        status: 'running',
        from: '2026-10-01',
        to: null,
        report_currency: 'EUR',
        metrics: ['aov'],
      },
      400,
      { error: 'unknown_metric', field: 'aov' },
    ],
  ])('PUT subscription %p → %i', async (body, status, error) => {
    const res = await fetch(`${base}/api/v1/experiments/1717/subscription`, {
      method: 'PUT',
      headers: auth,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual(error);
  });

  it('POST queries with an unknown view → 400 unknown_view', async () => {
    const res = await fetch(`${base}/api/v1/experiments/1717/queries`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ view: 'funnel', project_id: 42 }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'unknown_view', field: 'view' });
  });

  it('malformed ids → 404', async () => {
    const summary = await fetch(`${base}/api/v1/experiments/abc/daily-summary`, { headers: auth });
    expect(summary.status).toBe(404);
    expect(await summary.json()).toEqual({ error: 'not_subscribed' });
    const query = await fetch(`${base}/api/v1/experiments/1717/queries/nope?project_id=42`, {
      headers: auth,
    });
    expect(query.status).toBe(404);
    expect(await query.json()).toEqual({ error: 'query_not_found' });
  });

  it.each([
    ['DELETE', '/api/v1/experiments/1717/subscription'],
    ['GET', '/api/v1/experiments/1717/daily-summary'],
    ['GET', '/api/v1/experiments/1717/daily-summary?project_id=-1'],
    ['GET', `/api/v1/experiments/1717/queries/${'a'.repeat(64)}`],
  ])('R3: %s %s without a valid project_id → 400 invalid_body', async (method, path) => {
    const res = await fetch(base + path, { method, headers: auth });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_body', field: 'project_id' });
  });

  it.each([
    [{ status: 'running' }, 'PUT', 'subscription'],
    [{ project_id: 'abc', status: 'running' }, 'PUT', 'subscription'],
    [{ view: 'summary', metrics: ['purchase'] }, 'POST', 'queries'],
  ])('R3: body %p on %s %s → 400 invalid_body', async (body, method, rest) => {
    const res = await fetch(`${base}/api/v1/experiments/1717/${rest}`, {
      method,
      headers: auth,
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_body', field: 'project_id' });
  });

  it('the old /api/v1/metrics/:metric stub is gone', async () => {
    const res = await fetch(`${base}/api/v1/metrics/aov`, { headers: auth });
    expect(res.status).toBe(404);
  });

  it('the token middleware does not cover other /api/v1 routes', async () => {
    const res = await fetch(`${base}/api/v1/config/does-not-exist`);
    expect(res.status).not.toBe(401);
  });
});
