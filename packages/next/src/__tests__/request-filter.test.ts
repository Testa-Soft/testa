/**
 * Internal request filter — proves the proxy is safe with NO `config.matcher`:
 * assets, /_next/*, and API routes are never treated as pages.
 */

import { describe, expect, it } from 'vitest';
import { shouldBypassRequest } from '../request-filter.ts';

describe('shouldBypassRequest', () => {
  it.each([
    '/_next/static/chunks/main.js',
    '/_next/image?url=%2Fhero.png',
    '/_next/data/build-id/pricing.json',
    '/api/leads',
    '/api',
    '/.well-known/security.txt',
  ])('bypasses framework/API path %s', (pathname) => {
    expect(shouldBypassRequest(pathname)).toBe(true);
  });

  it.each([
    '/favicon.ico',
    '/robots.txt',
    '/sitemap.xml',
    '/logo.png',
    '/img/hero.avif',
    '/fonts/inter.woff2',
    '/assets/app.css',
    '/downloads/whitepaper.PDF',
    '/manifest.webmanifest',
    '/media/demo.mp4',
  ])('bypasses static asset %s', (pathname) => {
    expect(shouldBypassRequest(pathname)).toBe(true);
  });

  it.each([
    '/',
    '/pricing',
    '/pricing-v2',
    '/docs/v1.2', // dot in a segment is NOT an asset extension
    '/blog/what-is-a.b-test',
    '/apis', // only /api and /api/* bypass, not lookalike pages
    '/apidocs',
  ])('does NOT bypass page path %s', (pathname) => {
    expect(shouldBypassRequest(pathname)).toBe(false);
  });

  it('bypasses custom skipPaths string prefixes', () => {
    expect(shouldBypassRequest('/admin/settings', ['/admin'])).toBe(true);
    expect(shouldBypassRequest('/administrator', ['/admin/'])).toBe(false);
    expect(shouldBypassRequest('/administrator', ['/admin'])).toBe(false); // segment boundary, not raw startsWith
    expect(shouldBypassRequest('/pricing', ['/admin'])).toBe(false);
  });

  it('bypasses custom skipPaths regexes', () => {
    expect(shouldBypassRequest('/de/pricing', [/^\/(de|fr)\//])).toBe(true);
    expect(shouldBypassRequest('/pricing', [/^\/(de|fr)\//])).toBe(false);
  });
});
