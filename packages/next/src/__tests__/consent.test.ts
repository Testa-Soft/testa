/**
 * GDPR consent in the proxy: without a grant every cookie is a SESSION cookie
 * (bucketing still consistent for the session, server redirects still work);
 * a grant promotes the same id + assignment to persistent cookies.
 */
import { PERSISTENCE_COOKIE, UUID_BACKUP_COOKIE, UUID_COOKIE } from '@testa-soft/experiment-core';
import { NextRequest, type NextResponse } from 'next/server.js';
import { describe, expect, it } from 'vitest';
import { NextCookieStore } from '../cookie-store.ts';
import { type TestaProxyOptions, createTestaProxy } from '../middleware.ts';
import { splitUrlConfig } from './helpers.ts';

function req(cookie = ''): NextRequest {
  const headers = new Headers({ 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' });
  if (cookie) headers.set('cookie', cookie);
  return new NextRequest(new URL('https://acme.com/pricing'), { headers });
}

/** Raw Set-Cookie line per cookie name, attributes included. */
function setCookieLines(res: NextResponse): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of res.headers.entries()) {
    if (name.toLowerCase() !== 'set-cookie') continue;
    for (const line of value.split(/,(?=\s*_testa)/)) {
      const cookieName = line.trim().split('=')[0] ?? '';
      out[cookieName] = line.trim();
    }
  }
  return out;
}

const proxy = (extra: Partial<TestaProxyOptions> = {}) =>
  createTestaProxy({ projectSlug: 'acme', config: splitUrlConfig(), ...extra });

describe('proxy consent', () => {
  it('mints a SESSION visitor id by default (no Max-Age, no Expires)', async () => {
    const lines = setCookieLines(await proxy()(req()));
    expect(lines[UUID_COOKIE]).toBeDefined();
    expect(lines[UUID_COOKIE]).not.toMatch(/max-age|expires/i);
    expect(lines[UUID_BACKUP_COOKIE]).not.toMatch(/max-age|expires/i);
    expect(lines[PERSISTENCE_COOKIE]).toMatch(/^_testa_persist=s/);
  });

  it('persists once consent is granted', async () => {
    const lines = setCookieLines(await proxy({ consent: 'granted' })(req()));
    expect(lines[UUID_COOKIE]).toMatch(/max-age=34560000/i);
    expect(lines[PERSISTENCE_COOKIE]).toMatch(/^_testa_persist=p/);
  });

  it('promotes the SAME id on grant (no re-bucket)', async () => {
    const lines = setCookieLines(
      await proxy({ consent: () => 'granted' })(
        req(`${UUID_COOKIE}=v1; ${UUID_BACKUP_COOKIE}=v1; ${PERSISTENCE_COOKIE}=s`),
      ),
    );
    expect(lines[UUID_COOKIE]).toMatch(/^_testa_uuid=v1;.*max-age=34560000/i);
  });

  it('demotes cookies carried from before (no marker) once, as session cookies', async () => {
    const lines = setCookieLines(await proxy()(req(`${UUID_COOKIE}=v1; ${UUID_BACKUP_COOKIE}=v1`)));
    expect(lines[UUID_COOKIE]).toMatch(/^_testa_uuid=v1/);
    expect(lines[UUID_COOKIE]).not.toMatch(/max-age|expires/i);
  });

  it('follows a grant the client recorded when the proxy was not told', async () => {
    const lines = setCookieLines(
      await proxy()(req(`${UUID_COOKIE}=v1; ${UUID_BACKUP_COOKIE}=v1; ${PERSISTENCE_COOKIE}=p`)),
    );
    expect(lines[UUID_COOKIE]).toBeUndefined(); // nothing to re-write
    expect(lines[PERSISTENCE_COOKIE]).toBeUndefined();
  });

  it('lets an explicit denial win and treats a throwing resolver as "not told"', async () => {
    const denied = setCookieLines(
      await proxy({ consent: 'denied' })(req(`${UUID_COOKIE}=v1; ${PERSISTENCE_COOKIE}=p`)),
    );
    expect(denied[UUID_COOKIE]).not.toMatch(/max-age/i);
    const throwing = await proxy({
      consent: () => {
        throw new Error('cmp down');
      },
    })(req());
    expect(setCookieLines(throwing)[PERSISTENCE_COOKIE]).toMatch(/=s/);
  });
});

describe('NextCookieStore persistence', () => {
  const jar = () => {
    const writes: Record<string, Record<string, unknown>> = {};
    return {
      writes,
      set: (n: string, _v: string, o: Record<string, unknown>) => {
        writes[n] = o;
      },
    };
  };

  it('drops maxAge for long-lived cookies in session mode, keeps short ones and deletes', () => {
    const store = new NextCookieStore({ get: () => undefined });
    store.set('long', 'x', { maxAgeSec: 400 * 86400 });
    store.set('short', 'x', { maxAgeSec: 15 });
    store.set('gone', '', { maxAgeSec: 0 });
    const out = jar();
    store.applyTo(out);
    expect(out.writes.long).not.toHaveProperty('maxAge');
    expect(out.writes.short?.maxAge).toBe(15);
    expect(out.writes.gone?.maxAge).toBe(0);
  });
});
