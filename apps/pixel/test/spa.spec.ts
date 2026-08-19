/**
 * SPA redirect harness — task 3.11
 *
 * Exercises the pixel redirect engine across five framework fixture contexts:
 * plain JS, React Router 6, Next.js 12 (pages), Next.js 13 (app), Next.js 14
 * (app + PPR).  Each fixture is a minimal static HTML page served by http-server
 * from the pixel root directory.
 *
 * Assertions per fixture:
 *   1. Navigating to page-A with UTM params results in a redirect to page-B.
 *   2. page-B URL contains the original UTM params (query-param preservation).
 *   3. No second redirect fires on page-B (dedup cookie in effect).
 *   4. Clicking back (using `history.back()`) does NOT re-land on page-A because
 *      `location.replace` was used — the page-A entry was replaced in history by
 *      page-B, so going back skips page-A entirely.
 */

import { expect, test } from '@playwright/test';

/** Each entry describes one fixture directory under test/spa-fixtures/. */
const FIXTURES = [
  { name: 'plain-js', dir: 'plain-js' },
  { name: 'react-router6', dir: 'react-router6' },
  { name: 'next12-pages', dir: 'next12-pages' },
  { name: 'next13-app', dir: 'next13-app' },
  { name: 'next14-app', dir: 'next14-app' },
] as const;

const UTM = 'utm_source=test&utm_campaign=q2';

for (const fixture of FIXTURES) {
  test.describe(`SPA redirect — ${fixture.name}`, () => {
    /**
     * 1. Navigate to page-B first to establish a history entry before page-A.
     *    This lets us later verify that `goBack()` from page-B skips page-A
     *    (proving location.replace was used, not location.assign).
     * 2. Navigate to page-A with UTM params.
     * 3. Wait for the pixel to fire and the browser to land on page-B.
     * 4. Assert UTM params are on page-B's URL.
     * 5. Assert no second redirect fired on page-B.
     * 6. Go back — should land on the page-B we visited first, NOT page-A.
     */
    test('redirects to page-B, preserves UTM params, no re-redirect, replace not assign', async ({
      page,
      baseURL,
    }) => {
      const base = baseURL ?? 'http://localhost:5175';

      // Step 1 — prime history with a page-B visit so goBack() has somewhere to go.
      await page.goto(`${base}/test/spa-fixtures/${fixture.dir}/page-b.html`);
      await expect(page.locator('h1')).toBeVisible();

      // Step 2 — navigate to page-A with UTM params.
      await page.goto(`${base}/test/spa-fixtures/${fixture.dir}/page-a.html?${UTM}`);

      // Step 3 — wait for redirect (the pixel fires location.replace synchronously
      // after the runtime hydrates, so the navigation is near-instant).
      await expect(page).toHaveURL(new RegExp(`/test/spa-fixtures/${fixture.dir}/page-b\\.html`), {
        timeout: 5_000,
      });

      // Step 4 — UTM params must be present on page-B.
      const url = new URL(page.url());
      expect(url.searchParams.get('utm_source')).toBe('test');
      expect(url.searchParams.get('utm_campaign')).toBe('q2');

      // Step 5 — the pixel on page-B should evaluate the experiment but NOT fire
      // another redirect.  The dedup cookie (_testa_redirected_9001) blocks it.
      // We wait for the deferred runtime to finish hydrating before reading debug.
      await page.waitForFunction(
        () => {
          const d = (window as Record<string, unknown>).__pixel_debug as
            | { redirects?: Array<{ phase: string }> }
            | undefined;
          // Runtime has loaded once at least one breadcrumb exists or 800ms pass.
          return d?.redirects !== undefined;
        },
        null,
        { timeout: 5_000 },
      );

      const firedOnB = await page.evaluate(() => {
        const d = (window as Record<string, unknown>).__pixel_debug as
          | { redirects?: Array<{ phase: string }> }
          | undefined;
        return (d?.redirects ?? []).filter((r) => r.phase === 'fired').length;
      });
      expect(firedOnB).toBe(0); // dedup cookie prevented second redirect

      // Step 6 — go back. Because location.replace was used, history entry for
      // page-A was replaced by page-B, so going back skips page-A.
      await page.goBack();
      await expect(page).not.toHaveURL(
        new RegExp(`/test/spa-fixtures/${fixture.dir}/page-a\\.html`),
        { timeout: 3_000 },
      );
    });

    test.describe('Next.js hydration window (Next.js fixtures only)', () => {
      // These assertions only run for Next.js fixtures where the framework's
      // replaceState fires BEFORE the pixel runtime loads (script[defer]).
      if (!fixture.name.startsWith('next')) return;

      test('redirect fires despite router replaceState racing the pixel', async ({
        page,
        baseURL,
      }) => {
        const base = baseURL ?? 'http://localhost:5175';

        // Capture console errors to detect hydration-mismatch warnings.
        const consoleErrors: string[] = [];
        page.on('console', (msg) => {
          if (msg.type() === 'error') consoleErrors.push(msg.text());
        });

        await page.goto(`${base}/test/spa-fixtures/${fixture.dir}/page-a.html?${UTM}`);

        // Pixel must still redirect despite the router's replaceState mutation.
        await expect(page).toHaveURL(
          new RegExp(`/test/spa-fixtures/${fixture.dir}/page-b\\.html`),
          { timeout: 5_000 },
        );

        // UTM params intact.
        const url = new URL(page.url());
        expect(url.searchParams.get('utm_source')).toBe('test');

        // No hydration-mismatch errors logged.
        const hydrationErrors = consoleErrors.filter((e) => /hydrat|mismatch/i.test(e));
        expect(hydrationErrors).toHaveLength(0);
      });
    });
  });
}
