/**
 * Public-URL resolution — recover the URL the VISITOR requested.
 *
 * On Vercel `req.url` is the real public URL, but self-hosted topologies
 * (k8s ingress, istio sidecars, a CDN in front) often rewrite `Host` before
 * the request reaches Next.js, so `req.url` carries an internal host
 * (`pod-ip:3000`, `svc.cluster.local`). Split-URL targeting matches regexes
 * against PUBLIC URLs, cookie-domain discovery needs the public hostname, and
 * redirect Locations must resolve against the public origin — so the proxy
 * resolves the public URL through this chain (first valid candidate wins):
 *
 *   1. `publicHost` option / `TESTA_PUBLIC_HOST` env — explicit, always wins.
 *   2. `x-testa-host` (+ optional `x-testa-proto`) request headers — the
 *      infra-level escape hatch: set them at the ingress/mesh when it mangles
 *      `Host` and you can't (or don't want to) change app code.
 *   3. RFC 7239 `Forwarded` (`host=` / `proto=` of the first element).
 *   4. `X-Forwarded-Host` / `X-Forwarded-Proto` (first value of each list).
 *   5. The `Host` header, then the request URL as-is.
 *
 * PORTS come only from the winning host itself; `X-Forwarded-Port` is not
 * trusted to add one (see the note below).
 *
 * Host and proto resolve independently through the same chain, so a bare
 * `publicHost: 'www.acme.com'` still picks up `https` from the forwarded
 * headers. Every candidate is syntax-validated; a malformed (or maliciously
 * injected) value falls through to the next mechanism instead of poisoning
 * targeting or redirects. NOTE for integrators: these are request headers —
 * an ingress that doesn't own them should strip client-sent values.
 */

import { PUBLIC_HOST_HEADER, PUBLIC_PROTO_HEADER } from './constants.ts';

/** Structural subset of `NextRequest` the resolver needs (keeps this module host-neutral). */
export interface PublicUrlRequest {
  url: string;
  headers: Headers;
}

/** Explicit public host: `'www.acme.com'`, `'https://www.acme.com'`, or per-request. */
export type PublicHostOption<R extends PublicUrlRequest = PublicUrlRequest> =
  | string
  | ((req: R) => string | null | undefined);

// hostname (letters/digits/hyphens, dot-separated) or bracketed IPv6, optional :port
const HOST_RE =
  /^([a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*|\[[0-9a-f:.]+\])(:\d{1,5})?$/i;

function validHost(value: string | null | undefined): string | undefined {
  const host = value?.trim().toLowerCase();
  if (!host || !HOST_RE.test(host)) return undefined;
  // An out-of-range port rejects THIS candidate (falls through to the next
  // mechanism) instead of blowing up URL construction later and discarding a
  // perfectly valid hostname along with it.
  const port = /:(\d{1,5})$/.exec(host)?.[1];
  return port === undefined || validPort(port) ? host : undefined;
}

/** A syntactically valid TCP port (1–65535), or undefined. */
function validPort(value: string | null | undefined): string | undefined {
  const port = value?.trim();
  if (!port || !/^\d{1,5}$/.test(port)) return undefined;
  const n = Number(port);
  return n >= 1 && n <= 65535 ? port : undefined;
}

function validProto(value: string | null | undefined): string | undefined {
  const proto = value?.trim().toLowerCase();
  return proto === 'http' || proto === 'https' ? proto : undefined;
}

/** First item of a comma-separated header value (the client-nearest proxy's). */
function firstValue(header: string | null): string | undefined {
  return header?.split(',')[0]?.trim() || undefined;
}

/** `host=` / `proto=` of the FIRST element of an RFC 7239 `Forwarded` header. */
function parseForwarded(header: string | null): { host?: string; proto?: string } {
  const first = firstValue(header);
  if (!first) return {};
  const pairs = first.split(';').map((pair) => pair.split('=').map((s) => s.trim()));
  const unquote = (v: string | undefined): string | undefined => v?.replace(/^"(.*)"$/, '$1');
  const get = (key: string): string | undefined =>
    unquote(pairs.find(([k]) => k?.toLowerCase() === key)?.[1]);
  return {
    ...(get('host') ? { host: get('host') as string } : {}),
    ...(get('proto') ? { proto: get('proto') as string } : {}),
  };
}

/** Split an explicit option value (`'host'` or `'scheme://host'`) into parts. */
function parseExplicit<R extends PublicUrlRequest>(
  option: PublicHostOption<R> | undefined,
  req: R,
): { host?: string; proto?: string } {
  const raw = typeof option === 'function' ? option(req) : option;
  if (!raw) return {};
  if (raw.includes('://')) {
    try {
      const url = new URL(raw);
      const host = validHost(url.host);
      const proto = validProto(url.protocol.replace(/:$/, ''));
      return { ...(host ? { host } : {}), ...(proto ? { proto } : {}) };
    } catch {
      return {};
    }
  }
  const host = validHost(raw.replace(/\/+$/, ''));
  return host ? { host } : {};
}

/** Which mechanism produced the public HOST — surfaced by debug tracing. */
export type PublicUrlSource =
  | 'option'
  | 'x-testa-host'
  | 'forwarded'
  | 'x-forwarded-host'
  | 'host'
  | 'request-url';

export interface ResolvedPublicUrl {
  url: URL;
  source: PublicUrlSource;
}

/**
 * The public URL for a request — public origin + the request's path/query —
 * plus WHICH mechanism won (for debug tracing). Never throws: any failure
 * returns the request URL unchanged (fail open).
 */
export function resolvePublicUrlDetailed<R extends PublicUrlRequest>(
  req: R,
  option?: PublicHostOption<R>,
): ResolvedPublicUrl {
  const url = new URL(req.url);
  const explicit = parseExplicit(option, req);
  const forwarded = parseForwarded(req.headers.get('forwarded'));

  const hostCandidates: ReadonlyArray<[string | undefined, PublicUrlSource]> = [
    [explicit.host, 'option'],
    [validHost(req.headers.get(PUBLIC_HOST_HEADER)), 'x-testa-host'],
    [validHost(forwarded.host), 'forwarded'],
    [validHost(firstValue(req.headers.get('x-forwarded-host'))), 'x-forwarded-host'],
    [validHost(req.headers.get('host')), 'host'],
  ];
  const winner = hostCandidates.find(([candidate]) => candidate !== undefined);
  const bareHost = winner?.[0] ?? url.host;
  const source: PublicUrlSource = winner?.[1] ?? 'request-url';

  const proto =
    explicit.proto ??
    validProto(req.headers.get(PUBLIC_PROTO_HEADER)) ??
    validProto(forwarded.proto) ??
    validProto(firstValue(req.headers.get('x-forwarded-proto'))) ??
    url.protocol.replace(/:$/, '');

  // `X-Forwarded-Port` is deliberately NOT read: meshes and ingress controllers
  // routinely set it to the port they forward TO (istio sends the app's own
  // `:3000`), and splicing that in yields `https://www.acme.com:3000/pricing` —
  // matching no rule an editor can author. A non-default PUBLIC port is stated
  // via `publicHost` / `x-testa-host` instead.

  if (bareHost === url.host && `${proto}:` === url.protocol) return { url, source };
  try {
    return { url: new URL(`${proto}://${bareHost}${url.pathname}${url.search}`), source };
  } catch {
    return { url, source: 'request-url' };
  }
}

/** The public URL alone — see `resolvePublicUrlDetailed`. */
export function resolvePublicUrl<R extends PublicUrlRequest>(
  req: R,
  option?: PublicHostOption<R>,
): URL {
  return resolvePublicUrlDetailed(req, option).url;
}
