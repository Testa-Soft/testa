/** `POST /api/v1/stats` stub over real HTTP. P3 replaces these expectations. */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Server } from 'bun';
import { config } from '../../config.ts';
import app from '../../index.ts';

let server: Server;
let base: string;

beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: app.fetch });
  base = `http://localhost:${server.port}`;
});
afterAll(() => {
  server.stop(true);
});

describe('stats endpoint stub (P0)', () => {
  it('401 without token', async () => {
    const res = await fetch(`${base}/api/v1/stats`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('501 not_implemented with the token', async () => {
    const res = await fetch(`${base}/api/v1/stats`, {
      method: 'POST',
      headers: { 'X-Service-Token': config.serviceToken, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: 'not_implemented' });
  });
});
