/**
 * Crawler detection for the proxy.
 *
 * The list itself lives in `@testa-soft/experiment-core` so the client engine
 * applies the SAME gate — a crawler that executes JavaScript would otherwise be
 * bypassed by the proxy and then bucketed by the browser.
 */

export { isCrawlerUserAgent } from '@testa-soft/experiment-core';
