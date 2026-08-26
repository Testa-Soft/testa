/**
 * The earliest possible config fetch: an inline `<head>` snippet that starts
 * the request while the HTML is still parsing.
 *
 * Without it the config fetch cannot begin until the framework bundle has
 * downloaded, parsed, and hydrated far enough to render the provider — easily
 * several hundred milliseconds into the load, and all of it AFTER the shield
 * went up. Everything the client owns waits on that fetch: DOM applies, and
 * (on a cold server instance) the split-URL redirect itself. Starting it in
 * `<head>` overlaps it with the bundle download instead of queueing behind it.
 *
 * The snippet stashes the in-flight promise on `window.__testa_config`, and
 * the SDKs adopt it instead of issuing their own request — so this is a head
 * start, never a duplicate fetch. If the snippet is absent, or its fetch
 * failed, the SDKs fall back to fetching normally.
 *
 * Kept dependency-free and tiny; it inlines next to the shield snippet.
 */

/** Well-known global the SDKs look for before starting their own fetch. */
export const CONFIG_PROMISE_KEY = '__testa_config';

export interface ConfigPreloadOptions {
  /** Absolute config URL to fetch (`{host}/api/v1/config/{projectId}`). */
  url: string;
}

/**
 * Build the inline `<head>` IIFE that kicks the config fetch.
 *
 * `cache: 'no-cache'` mirrors the SDK fetch: always revalidate, so a publish is
 * never hidden behind the browser's `max-age`, while a 304 keeps it cheap.
 * Failures resolve to null rather than rejecting, so an unhandled rejection can
 * never surface from a page that merely included the snippet.
 */
export function buildConfigPreloadSnippet(opts: ConfigPreloadOptions): string {
  const url = JSON.stringify(opts.url);
  const key = JSON.stringify(CONFIG_PROMISE_KEY);
  // The `_testa_t` token is built HERE, in the browser, at page-load time — not
  // baked into the string: `_document.tsx` renders at BUILD time for statically
  // optimized pages, so anything computed while generating this snippet would
  // be frozen into every future page load. A per-load URL is what stops the
  // browser answering from its own cache with a config that has since been
  // republished. Matches the token shape the SDK's own fetch appends.
  return `(function(){try{if(window[${key}])return;var u=${url};u+=(u.indexOf('?')<0?'?':'&')+'_testa_t='+Date.now().toString(36);window[${key}]=fetch(u,{headers:{accept:'application/json'},cache:'no-cache'}).then(function(r){return r.ok?r.json():null;}).catch(function(){return null;});}catch(e){}})();`;
}
