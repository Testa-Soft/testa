/**
 * URL matching for redirect rules. Ported (behaviour) from
 * `apps/pixel/src/runtime/redirect/match.ts`.
 *
 * Both URLs are canonicalized (lowercased host, sorted query keys, dropped
 * `_testa_*` params, stripped trailing slash) before comparison so visually-
 * equivalent URLs don't fail to match on cosmetic differences.
 */

import { safeUrl } from './url.ts';

const TESTA_PARAM_RE = /^_testa_/;

/**
 * Mode-aware match gate, mirroring the pixel's `urlMatches`. `url_match_type` selects
 * how `from_url` is matched against the current URL:
 *   - `contains` → substring test on the raw href (literal, ports included).
 *   - `regex`    → `from_url` compiled as a RegExp, tested against the href.
 *   - `exact` / `query` → canonical exact/glob/regex matching via `matchesUrl`.
 */
export function matchesForMode(
  currentUrl: string,
  fromUrl: string,
  mode: 'exact' | 'contains' | 'query' | 'regex',
): boolean {
  if (!fromUrl) return false;
  if (mode === 'contains') return currentUrl.includes(fromUrl);
  if (mode === 'regex') {
    try {
      return new RegExp(fromUrl).test(currentUrl);
    } catch {
      return false;
    }
  }
  return matchesUrl(currentUrl, fromUrl);
}

export function matchesUrl(currentUrl: string, pattern: string): boolean {
  if (!pattern) return false;
  if (pattern.startsWith('regex:')) {
    const body = pattern.slice('regex:'.length);
    try {
      return new RegExp(body).test(currentUrl);
    } catch {
      return false;
    }
  }
  if (pattern.includes('*')) {
    return globMatch(currentUrl, pattern);
  }
  return exactMatch(currentUrl, pattern);
}

/**
 * Exact match — host + pathname only. Query parameters are IGNORED, matching
 * the pixel's `urlMatches('exact')` behaviour: `/pricing` matches
 * `/pricing?utm_source=fb`. Current query params still flow to the redirect
 * destination via `merge-params.ts`; they just don't gate the match.
 *
 * PORTS count only when the PATTERN names one: `localhost:3200` and
 * `localhost:5002` are different sites, but a portless pattern (what a dashboard
 * editor authors) means the site on any port — self-hosted stacks leak internal
 * ports into the URL the app sees, and the dashboard cannot express "3000 in the
 * cluster, none in public". Protocol stays ignored (http/https unification).
 */
function exactMatch(currentUrl: string, pattern: string): boolean {
  const cur = safeUrl(currentUrl);
  const pat = safeUrl(pattern);
  if (!cur || !pat) return false;

  const hostsMatch = pat.port
    ? cur.host.toLowerCase() === pat.host.toLowerCase()
    : cur.hostname.toLowerCase() === pat.hostname.toLowerCase();
  if (!hostsMatch) return false;
  return normalizePath(cur.pathname) === normalizePath(pat.pathname);
}

function normalizePath(p: string): string {
  if (p.length > 1 && p.endsWith('/')) return p.slice(0, -1);
  return p;
}

/**
 * Canonical URL form for comparison:
 *   - lowercase host
 *   - drop `_testa_*` query params
 *   - sort remaining query keys
 *   - strip trailing slash on path (except root '/')
 *   - drop fragment
 */
export function canonicalize(rawUrl: string): string {
  const url = safeUrl(rawUrl);
  if (!url) return rawUrl;

  url.hostname = url.hostname.toLowerCase();

  const params = new URLSearchParams();
  const entries: Array<[string, string]> = [];
  url.searchParams.forEach((value, key) => {
    if (TESTA_PARAM_RE.test(key)) return;
    entries.push([key, value]);
  });
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [k, v] of entries) params.append(k, v);
  url.search = params.toString();

  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.slice(0, -1);
  }

  url.hash = '';

  return url.toString();
}

function globMatch(input: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  try {
    return new RegExp(`^${escaped}$`).test(input);
  } catch {
    return false;
  }
}
