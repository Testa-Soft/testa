/**
 * Mode-aware redirect-URL construction. Ported (behaviour) from
 * `apps/pixel/src/runtime/redirect/build-url.ts` — parity with legacy 3.3.3
 * `createRedirectUrl`.
 *
 * Operates ONLY on the passed-in `currentUrl` snapshot — it never reads
 * `window.location` (deliberate Next.js race-condition fix). Query merging is
 * delegated to `merge-params.ts`.
 *
 * Modes (default `exact`):
 *   - `exact`    → destination origin+pathname, merging current query params.
 *   - `contains` → first-occurrence string replace of `from_url` → `to_url`.
 *   - `query`    → keep current URL, set query params parsed from `to_url`.
 *   - `regex`    → treat `from_url` as a RegExp, expand `$1..$n` backrefs.
 */

import type { VariationChange } from '@testa-platform/shared-types';
import { mergeParams } from './merge-params.ts';
import { safeUrl } from './url.ts';

type RedirectChange = Extract<VariationChange, { type: 'redirect' }>;
export type RewriteMode = NonNullable<RedirectChange['url_match_type']>;

/** Resolve the rewrite mode, defaulting to `exact`. */
export function resolveMode(change: RedirectChange): RewriteMode {
  return change.url_match_type ?? 'exact';
}

/** Build the final redirect destination from the current URL snapshot. */
export function buildRedirectUrl(currentUrl: string, change: RedirectChange): string {
  switch (resolveMode(change)) {
    case 'contains':
      return buildContains(currentUrl, change);
    case 'query':
      return buildQuery(currentUrl, change);
    case 'regex':
      return buildRegex(currentUrl, change);
    default:
      return buildExact(currentUrl, change);
  }
}

function buildExact(currentUrl: string, change: RedirectChange): string {
  // mergeParams preserves relative-ness; just drop any fragment (exact mode
  // keeps origin + path + search only).
  return stripHash(mergeParams(currentUrl, change.to_url));
}

function stripHash(url: string): string {
  const i = url.indexOf('#');
  return i === -1 ? url : url.slice(0, i);
}

function buildContains(currentUrl: string, change: RedirectChange): string {
  return currentUrl.replace(change.from_url, change.to_url);
}

function buildQuery(currentUrl: string, change: RedirectChange): string {
  const url = safeUrl(currentUrl);
  if (!url) return currentUrl;

  for (const pair of change.to_url.split('&')) {
    if (!pair) continue;
    const [key, value] = pair.split('=');
    if (!key) continue;
    url.searchParams.set(key, value ?? '');
  }

  return url.toString();
}

function buildRegex(currentUrl: string, change: RedirectChange): string {
  let content = change.to_url;

  let re: RegExp;
  try {
    re = new RegExp(change.from_url, 'g');
  } catch {
    return sanitizeUrl(content);
  }

  const match = re.exec(currentUrl);
  if (match) {
    for (let i = 1; i < match.length; i++) {
      content = content.replace(`$${i}`, match[i] ?? '');
    }
  }

  // Preserve the current URL's query params on the regex destination too.
  return mergeParams(currentUrl, sanitizeUrl(content));
}

/** Collapse duplicate `?` into a single query separator. */
function sanitizeUrl(url: string): string {
  const parts = url.split('?');
  if (parts.length > 2) {
    const head = parts.shift() ?? '';
    return `${head}?${parts.join('&')}`;
  }
  return url;
}
