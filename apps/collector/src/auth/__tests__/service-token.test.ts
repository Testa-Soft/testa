import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { SERVICE_TOKEN_HEADER, serviceToken, tokenMatches } from '../service-token.ts';

const TOKEN = 'test-service-token-0123456789';

describe('tokenMatches', () => {
  it('matches only the exact token', () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(tokenMatches(undefined, TOKEN)).toBe(false);
    expect(tokenMatches('', TOKEN)).toBe(false);
    expect(tokenMatches(`${TOKEN}x`, TOKEN)).toBe(false);
    expect(tokenMatches(TOKEN.replace('0', '1'), TOKEN)).toBe(false);
  });
});

describe('serviceToken middleware', () => {
  const app = new Hono();
  app.use('*', serviceToken(TOKEN));
  app.get('/ok', (c) => c.json({ ok: true }));

  it('401 unauthorized without or with a wrong token', async () => {
    for (const headers of [{}, { [SERVICE_TOKEN_HEADER]: 'nope' }]) {
      const res = await app.request('/ok', { headers });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    }
  });

  it('passes with the right token', async () => {
    const res = await app.request('/ok', { headers: { [SERVICE_TOKEN_HEADER]: TOKEN } });
    expect(res.status).toBe(200);
  });

  it('refuses an empty configured token', () => {
    expect(() => serviceToken('')).toThrow();
  });
});
