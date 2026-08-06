import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { requireServiceToken } from '../auth.ts';

function makeRealApp(): Hono {
  const app = new Hono();
  app.use('*', requireServiceToken);
  app.get('/test', (c) => c.json({ ok: true }));
  return app;
}

describe('requireServiceToken', () => {
  it('returns 401 when X-Service-Token header is missing', async () => {
    const app = makeRealApp();
    const res = await app.fetch(new Request('http://localhost/test'));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect((body as { error: string }).error).toBe('unauthorized');
  });

  it('returns 401 when X-Service-Token is wrong', async () => {
    const app = makeRealApp();
    const res = await app.fetch(
      new Request('http://localhost/test', {
        headers: { 'x-service-token': 'wrong-token-that-is-also-long-enough' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('passes through to next handler when token matches config', async () => {
    // The default dev token from config.ts
    const devToken = 'dev-metrics-token-change-me-1234';
    const app = makeRealApp();
    const res = await app.fetch(
      new Request('http://localhost/test', {
        headers: { 'x-service-token': devToken },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect((body as { ok: boolean }).ok).toBe(true);
  });

  it('uses constant-time comparison (no early exit on wrong prefix)', async () => {
    // Behavioural test: a token that shares a correct prefix but differs at end
    // must also return 401. This isn't a timing oracle but confirms the logic path.
    const devToken = 'dev-metrics-token-change-me-1234';
    const wrongToken = `${devToken.slice(0, -1)}X`;
    const app = makeRealApp();
    const res = await app.fetch(
      new Request('http://localhost/test', {
        headers: { 'x-service-token': wrongToken },
      }),
    );
    expect(res.status).toBe(401);
  });
});
