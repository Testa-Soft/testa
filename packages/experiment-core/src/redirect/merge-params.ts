/**
 * Query-param merging for redirects. Ported (behaviour) from
 * `apps/pixel/src/runtime/redirect/merge-params.ts`, hardened to preserve the
 * target's relative-ness.
 *
 * Merge rules:
 *   - Start with the destination URL's params.
 *   - Layer the source URL's params on top, EXCEPT where the destination
 *     already specifies that key (destination wins — author's explicit intent).
 *   - Drop `_testa_*` params (internal markers).
 *
 * Relative-ness is preserved: a relative `targetUrl` (`/pricing-v2`) returns a
 * relative string, an absolute one returns absolute. This matters because the
 * caller resolves the result against the real request URL — returning a
 * placeholder-hosted absolute string would leak `placeholder.invalid`.
 *
 * Operates only on the passed-in `currentUrl` snapshot so framework-driven URL
 * rewrites mid-flight can't corrupt the destination.
 */

import { queryKeysOf, traceUrl } from '../trace.ts';
import { type SafeUrl, safeUrl } from './url.ts';

const TESTA_PARAM_RE = /^_testa_/;
const ABSOLUTE_URL_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

export function mergeParams(currentUrl: string, targetUrl: string): string {
  const targetIsAbsolute = ABSOLUTE_URL_RE.test(targetUrl);

  const target = safeUrl(targetUrl);
  // Unparseable destination: the visitor's params are dropped wholesale here.
  // Traced explicitly because the result looks like a deliberate destination.
  if (!target) {
    traceUrl({
      stage: 'merge-params',
      in: currentUrl,
      out: targetUrl,
      detail: { bail: 'bad-target' },
    });
    return targetUrl;
  }

  const current = safeUrl(currentUrl);
  if (!current) {
    const out = targetIsAbsolute ? target.toString() : relativeOf(target);
    traceUrl({ stage: 'merge-params', in: currentUrl, out, detail: { bail: 'bad-current' } });
    return out;
  }

  const carried: string[] = [];
  current.searchParams.forEach((value, key) => {
    if (TESTA_PARAM_RE.test(key)) return;
    if (target.searchParams.has(key)) return;
    target.searchParams.append(key, value);
    carried.push(key);
  });

  const out = targetIsAbsolute ? target.toString() : relativeOf(target);
  traceUrl({
    stage: 'merge-params',
    in: currentUrl,
    out,
    detail: {
      target: targetUrl,
      carried,
      inKeys: queryKeysOf(currentUrl),
      outKeys: queryKeysOf(out),
    },
  });
  return out;
}

function relativeOf(u: SafeUrl): string {
  return `${u.pathname}${u.search}${u.hash}`;
}
