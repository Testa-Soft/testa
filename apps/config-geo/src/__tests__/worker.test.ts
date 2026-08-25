import { describe, expect, it, vi } from 'vitest';
import { type GeoData, geoOf, handleConfigRequest } from '../index.ts';

const CONFIG_URL = 'https://config.testa-soft.tech/api/v1/config/6a8418d12335d';
const GEO: GeoData = { country: 'LT', region: 'VL', city: 'Vilnius' };

const ORIGIN_CONFIG = {
  project_id: 1,
  slug: 'acme',
  config_hash: 'hash-1',
  experiments: [],
};

function originJson(): Response {
  return new Response(JSON.stringify(ORIGIN_CONFIG), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=60, stale-while-revalidate=300',
      etag: '"hash-1"',
      'content-length': '64',
    },
  });
}

function fetchReturning(response: Response): typeof fetch {
  return vi.fn(async () => response) as unknown as typeof fetch;
}

describe('handleConfigRequest — geo splice', () => {
  it('splices geo into a 200 JSON body, preserving the config fields', async () => {
    const res = await handleConfigRequest(new Request(CONFIG_URL), GEO, fetchReturning(originJson()));
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ ...ORIGIN_CONFIG, geo: GEO });
    expect(res.status).toBe(200);
  });

  it('marks the spliced body private, allows CORS, keeps the ETag, drops content-length', async () => {
    const res = await handleConfigRequest(new Request(CONFIG_URL), GEO, fetchReturning(originJson()));
    expect(res.headers.get('cache-control')).toBe('private, max-age=30');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('etag')).toBe('"hash-1"');
    // The origin's content-length no longer applies to the spliced body.
    expect(res.headers.get('content-length')).not.toBe('64');
  });
});

describe('handleConfigRequest — pass-through', () => {
  it('passes non-GET requests straight to the origin', async () => {
    const originResponse = new Response('published', { status: 200 });
    const fetchImpl = fetchReturning(originResponse);
    const res = await handleConfigRequest(
      new Request(CONFIG_URL, { method: 'POST' }),
      GEO,
      fetchImpl,
    );
    expect(res).toBe(originResponse);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('passes 304 revalidations through untouched', async () => {
    const notModified = new Response(null, { status: 304, headers: { etag: '"hash-1"' } });
    const res = await handleConfigRequest(new Request(CONFIG_URL), GEO, fetchReturning(notModified));
    expect(res).toBe(notModified);
  });

  it('passes error responses through untouched', async () => {
    const notFound = new Response(JSON.stringify({ ok: false }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
    const res = await handleConfigRequest(new Request(CONFIG_URL), GEO, fetchReturning(notFound));
    expect(res).toBe(notFound);
  });

  it('passes non-JSON responses through untouched', async () => {
    const html = new Response('<html></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
    const res = await handleConfigRequest(new Request(CONFIG_URL), GEO, fetchReturning(html));
    expect(res).toBe(html);
  });

  it('serves an unparsable JSON body verbatim instead of corrupting it', async () => {
    const broken = new Response('{not json', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const res = await handleConfigRequest(new Request(CONFIG_URL), GEO, fetchReturning(broken));
    expect(await res.text()).toBe('{not json');
    expect(res.status).toBe(200);
  });
});

describe('geoOf', () => {
  it('reads country/regionCode/city off request.cf', () => {
    const request = {
      cf: { country: 'LT', regionCode: 'VL', city: 'Vilnius' },
    } as unknown as Request;
    expect(geoOf(request)).toEqual(GEO);
  });

  it('falls back to empty strings when cf is missing (e.g. wrangler dev)', () => {
    const request = {} as Request;
    expect(geoOf(request)).toEqual({ country: '', region: '', city: '' });
  });
});
