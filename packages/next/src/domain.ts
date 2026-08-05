/**
 * Cookie-domain resolution for cross-(sub)domain tracking.
 *
 * By default the middleware sets host-only cookies (no `Domain` attribute), so
 * `app.acme.com` and `www.acme.com` would NOT share a visitor id / assignment.
 * Two opt-ins fix that:
 *   - `cookieDomain: '.acme.com'` — set the Domain explicitly (authoritative).
 *   - `discoverRootDomain: true`  — derive the registrable domain from the
 *     request host and set `Domain=<root>` so all subdomains share cookies.
 *
 * Discovery uses a small multi-part public-suffix set + a last-two-labels
 * fallback. It is a heuristic, not the full Public Suffix List — for exotic
 * suffixes, set `cookieDomain` explicitly. `localhost` and IP hosts return
 * undefined (browsers reject `Domain` cookies for them), so local dev keeps
 * working with host-only cookies.
 */

// Common two-label public suffixes where the registrable domain is 3 labels.
const MULTI_PART_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'gov.uk',
  'ac.uk',
  'me.uk',
  'com.au',
  'net.au',
  'org.au',
  'co.nz',
  'co.jp',
  'co.kr',
  'com.br',
  'com.mx',
  'co.za',
  'co.in',
  'com.sg',
]);

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

function isIpHost(host: string): boolean {
  return IPV4_RE.test(host) || host.includes(':');
}

/**
 * The registrable ("root") domain for a hostname, or undefined when a Domain
 * cookie can't/shouldn't be set (localhost, IP, single-label host).
 */
export function rootDomainOf(hostname: string): string | undefined {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return undefined;
  if (isIpHost(host)) return undefined;

  const labels = host.split('.').filter(Boolean);
  if (labels.length < 2) return undefined;
  if (labels.length === 2) return labels.join('.');

  const lastTwo = labels.slice(-2).join('.');
  if (MULTI_PART_SUFFIXES.has(lastTwo)) return labels.slice(-3).join('.');
  return lastTwo;
}

export interface CookieDomainOptions {
  /** Explicit cookie Domain (e.g. `.acme.com`). Wins over discovery. */
  cookieDomain?: string;
  /** Auto-derive the registrable domain from the request host. */
  discoverRootDomain?: boolean;
}

/** Resolve the effective cookie Domain for a request host, or undefined (host-only). */
export function resolveCookieDomain(
  hostname: string,
  opts: CookieDomainOptions,
): string | undefined {
  if (opts.cookieDomain) return opts.cookieDomain;
  if (opts.discoverRootDomain) return rootDomainOf(hostname);
  return undefined;
}
