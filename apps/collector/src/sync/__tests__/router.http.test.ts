/**
 * The mounted sync API stubs over real HTTP (the collector's own app on an
 * ephemeral port). P4 replaces these expectations with the real behaviour.
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
  ['DELETE', '/api/v1/experiments/1717/subscription'],
  ['GET', '/api/v1/experiments/1717/daily-summary?since_run_id=r_1'],
  ['POST', '/api/v1/experiments/1717/queries'],
  ['GET', '/api/v1/experiments/1717/queries/q_abc'],
];

describe('sync API stubs (P0)', () => {
  for (const [method, path] of ROUTES) {
    it(`${method} ${path} → 401 without token, 501 not_implemented with it`, async () => {
      const anon = await fetch(base + path, { method });
      expect(anon.status).toBe(401);
      expect(await anon.json()).toEqual({ error: 'unauthorized' });

      const res = await fetch(base + path, {
        method,
        headers: auth,
        ...(method === 'GET' || method === 'DELETE' ? {} : { body: '{}' }),
      });
      expect(res.status).toBe(501);
      expect(await res.json()).toEqual({ error: 'not_implemented' });
    });
  }

  it('the old /api/v1/metrics/:metric stub is gone', async () => {
    const res = await fetch(`${base}/api/v1/metrics/aov`, { headers: auth });
    expect(res.status).toBe(404);
  });

  it('the token middleware does not cover other /api/v1 routes', async () => {
    const res = await fetch(`${base}/api/v1/config/does-not-exist`);
    expect(res.status).not.toBe(401);
  });
});
