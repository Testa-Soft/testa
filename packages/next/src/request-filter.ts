/**
 * Internal request filter — the correctness half of the `config.matcher` story.
 *
 * Next.js requires the customer's `export const config = { matcher: [...] }`
 * to be a statically-analyzable literal (SWC parses it at build time), so this
 * package can never own the matcher. The matcher is therefore only a COST
 * optimization (it skips the edge invocation entirely); THIS guard owns
 * correctness: even with no matcher at all — or a wrong one — the proxy never
 * redirects, sets cookies on, tracks, or fetches config for a non-page request.
 */

/** Path prefixes that are never pages: framework internals + API routes. */
const BYPASS_PREFIXES = ['/_next', '/api', '/.well-known'] as const;

/** File extensions that are always static assets, never pages. */
const ASSET_EXTENSIONS = new Set([
  // images
  'avif',
  'bmp',
  'gif',
  'ico',
  'jpeg',
  'jpg',
  'png',
  'svg',
  'webp',
  // fonts
  'eot',
  'otf',
  'ttf',
  'woff',
  'woff2',
  // scripts / styles / sourcemaps
  'css',
  'js',
  'map',
  'mjs',
  // data / documents
  'csv',
  'json',
  'pdf',
  'rss',
  'txt',
  'xml',
  'xsl',
  // media
  'aac',
  'm4a',
  'mov',
  'mp3',
  'mp4',
  'ogg',
  'wav',
  'webm',
  // misc bundles
  'br',
  'gz',
  'wasm',
  'webmanifest',
  'zip',
]);

/** Custom bypass rules: string = path prefix (segment-aligned), RegExp = pathname test. */
export type SkipPath = string | RegExp;

/**
 * True for the only methods that can be a visitor-facing document load.
 * Everything else must pass through untouched: Server Actions and form
 * submits POST to the CURRENT page URL, so a matching split-URL rule would
 * 307-redirect the POST (307 preserves the method) and break the action —
 * the visitor just stays on the page. Method comparison is case-sensitive
 * per the fetch spec (methods are normalized to uppercase).
 */
export function isDocumentMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD';
}

/**
 * True when the middleware must pass this request through untouched — it is a
 * framework/API/asset request (or matches a caller-supplied skip rule), not a
 * page a visitor sees.
 */
export function shouldBypassRequest(
  pathname: string,
  skipPaths?: ReadonlyArray<SkipPath>,
): boolean {
  if (BYPASS_PREFIXES.some((prefix) => isPrefixSegment(pathname, prefix))) return true;
  if (hasAssetExtension(pathname)) return true;
  if (skipPaths?.some((rule) => matchesSkipRule(pathname, rule))) return true;
  return false;
}

/** `/api` matches `/api` and `/api/leads` but never `/apis` (segment boundary). */
function isPrefixSegment(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** True when the LAST path segment ends in a known static-asset extension. */
function hasAssetExtension(pathname: string): boolean {
  const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1);
  const dot = lastSegment.lastIndexOf('.');
  if (dot <= 0) return false; // no extension, or dotfile like `.env`
  return ASSET_EXTENSIONS.has(lastSegment.slice(dot + 1).toLowerCase());
}

function matchesSkipRule(pathname: string, rule: SkipPath): boolean {
  if (typeof rule === 'string') {
    return isPrefixSegment(pathname, rule.replace(/\/+$/, ''));
  }
  return rule.test(pathname);
}
