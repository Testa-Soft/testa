/**
 * Cloudflare Worker on `config.testa-soft.tech/api/v1/config/*`.
 *
 * Splices the visitor's geo (from `request.cf`) into the config JSON on the
 * way out, so browser-side SDKs receive `config.geo` for geo targeting with
 * no extra request.
 *
 * Speed model (same as the legacy geo-injection worker): the `fetch(request)`
 * subrequest flows through Cloudflare's edge cache, so on a cache hit the
 * geo-less origin body is served from the PoP and the collector is never
 * touched. This worker itself runs on every request and personalizes the body
 * per visitor. The spliced response is marked `private` so no shared cache
 * ever stores a per-visitor body — the shared edge cache only ever holds the
 * geo-less origin response.
 *
 * Everything that is not a 200 JSON GET (publish POSTs, 304 revalidations,
 * errors, non-JSON bodies) passes through untouched.
 */

/** Mirrors `GeoData` in `@testa-platform/shared-types`. Empty string = unknown. */
export interface GeoData {
  country: string;
  region: string;
  city: string;
}

/** How long the VISITOR'S OWN browser may cache the spliced body (seconds). */
const BROWSER_CACHE_SECONDS = 60;

/** Read the visitor's geo off the request. Cloudflare populates `cf` pre-worker. */
export function geoOf(request: Request): GeoData {
  const cf = request.cf;
  return {
    country: typeof cf?.country === 'string' ? cf.country : '',
    region: typeof cf?.regionCode === 'string' ? cf.regionCode : '',
    city: typeof cf?.city === 'string' ? cf.city : '',
  };
}

/**
 * Fetch the origin (through the CF cache) and splice `geo` into a 200 JSON
 * body. `fetchImpl` is injectable for tests.
 */
export async function handleConfigRequest(
  request: Request,
  geo: GeoData,
  fetchImpl: typeof fetch,
): Promise<Response> {
  if (request.method !== 'GET') return fetchImpl(request);

  const response = await fetchImpl(request);

  // 304 revalidations pass through: the browser's cached body already carries
  // its own geo. Errors pass through so their bodies are never rewritten.
  if (response.status !== 200) return response;

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return response;

  const text = await response.text();
  const config = parseJsonObject(text);
  // Unparsable / non-object body — rebuild the origin response verbatim.
  if (config === null) return new Response(text, response);

  const headers = new Headers(response.headers);
  // Body changed → the origin's length no longer applies; the runtime recomputes.
  headers.delete('content-length');
  // Per-visitor body: only the visitor's own browser may cache it. The shared
  // edge cache keeps serving the geo-less ORIGIN response to this worker.
  headers.set('cache-control', `private, max-age=${BROWSER_CACHE_SECONDS}`);
  // The config is public data fetched cross-origin by customer-site SDKs.
  headers.set('access-control-allow-origin', '*');

  return new Response(JSON.stringify({ ...config, geo }), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    return handleConfigRequest(request, geoOf(request), fetch);
  },
} satisfies ExportedHandler;
