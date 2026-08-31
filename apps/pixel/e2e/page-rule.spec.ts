/**
 * Real-browser proof of the page-rule gate: a DOM (HTML) experiment applies
 * ONLY where its rule matches, and the ONLY ways it reaches more than one page
 * are the rule types that are supposed to — `contains`, `regex`, and the
 * site-wide `contains` the collector maps `site_wide` to.
 *
 * Runs the actual shipped bundles (dist/loader.min.js + dist/runtime.min.js)
 * against static pages in Chromium — happy-dom unit tests can't prove the
 * MutationObserver/history-patch behaviour the way a real browser does.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Page, expect, test } from '@playwright/test';

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const CONTROL = 'Control headline';
const VARIANT = 'Variant headline';

type Rule = { match_type: string; url_pattern: string };

/** One active `change_html` experiment, 100% traffic into a single variant. */
function config(rules: Rule[]) {
  return {
    project_id: 9999,
    slug: 'e2e',
    integration_version: '4.0',
    consent_mode: 'aware',
    published_at: '',
    config_hash: 'e2e',
    experiments: [
      {
        experiment_id: 17,
        title: 'headline test',
        status: 'active',
        traffic_allocation: 100,
        rules,
        goals: [],
        variations: [
          {
            variation_id: 100,
            weight: 100,
            changes: [{ type: 'change_html', selector: 'h1', content: VARIANT }],
          },
        ],
      },
    ],
  };
}

/** Boot the real pixel on `path` with `rules`: loader (sync) then runtime (defer). */
async function boot(page: Page, rules: Rule[], path: string): Promise<void> {
  await page.route('**/track*', (r) => r.fulfill({ status: 204, body: '' }));
  await page.addInitScript((cfg) => {
    (window as unknown as { cfPrefill: unknown }).cfPrefill = { project: cfg };
  }, config(rules));
  await page.goto(path);
  await page.addScriptTag({ path: `${DIST}/loader.min.js` });
  await page.addScriptTag({ path: `${DIST}/runtime.min.js` });
}

const headline = (page: Page) => page.locator('h1').innerHTML();

/** Soft navigation, the way a router does it (the loader patches pushState). */
async function softNav(page: Page, to: string): Promise<void> {
  await page.evaluate((url) => {
    history.pushState({}, '', url);
  }, to);
}

test.describe('exact rule — one page only', () => {
  const rules = [{ match_type: 'exact', url_pattern: 'http://localhost:5173/pricing.html' }];

  test('applies on the experiment page', async ({ page }) => {
    await boot(page, rules, '/pricing.html');
    await expect(page.locator('h1')).toHaveText(VARIANT);
  });

  test('does NOT apply on any other page', async ({ page }) => {
    for (const path of ['/blog.html', '/checkout.html', '/product-a.html']) {
      await boot(page, rules, path);
      expect(await headline(page)).toBe(CONTROL);
    }
  });
});

test.describe('contains rule — every matching page, and only those', () => {
  const rules = [{ match_type: 'contains', url_pattern: '/product' }];

  test('applies on both product pages', async ({ page }) => {
    await boot(page, rules, '/product-a.html');
    await expect(page.locator('h1')).toHaveText(VARIANT);
    await boot(page, rules, '/product-b.html');
    await expect(page.locator('h1')).toHaveText(VARIANT);
  });

  test('does not leak onto a non-matching page', async ({ page }) => {
    await boot(page, rules, '/blog.html');
    expect(await headline(page)).toBe(CONTROL);
  });
});

test.describe('regex rule — every matching page, and only those', () => {
  const rules = [{ match_type: 'regex', url_pattern: '/(pricing|checkout)\\.html' }];

  test('applies on both branches of the alternation', async ({ page }) => {
    await boot(page, rules, '/pricing.html');
    await expect(page.locator('h1')).toHaveText(VARIANT);
    await boot(page, rules, '/checkout.html');
    await expect(page.locator('h1')).toHaveText(VARIANT);
  });

  test('does not apply where the pattern misses', async ({ page }) => {
    await boot(page, rules, '/blog.html');
    expect(await headline(page)).toBe(CONTROL);
  });
});

test.describe('site-wide rule — every page by design', () => {
  // What the collector maps crobot's `url_match_type: 'site_wide'` to
  // (build.ts `mapRuleMatchType`): a `contains` on the site URL.
  const rules = [{ match_type: 'contains', url_pattern: 'localhost:5173' }];

  test('applies everywhere', async ({ page }) => {
    for (const path of ['/pricing.html', '/blog.html', '/product-a.html']) {
      await boot(page, rules, path);
      expect(await headline(page)).toBe(VARIANT);
    }
  });
});

test.describe('bucketing + soft navigation', () => {
  const rules = [{ match_type: 'contains', url_pattern: '/pricing' }];

  test('URL matches AND visitor is bucketed → the change shows', async ({ page }) => {
    await boot(page, rules, '/pricing.html');
    await expect(page.locator('h1')).toHaveText(VARIANT);

    const cookie = (await page.context().cookies()).find((c) => c.name === '_testa_exp');
    expect(cookie?.value).toContain('17.100'); // experiment 17 → variation 100
  });

  test('soft nav off the page wipes it; soft nav back re-applies it', async ({ page }) => {
    await boot(page, rules, '/pricing.html');
    await expect(page.locator('h1')).toHaveText(VARIANT);

    await softNav(page, '/blog.html');
    // Undebounced teardown — asserted with no wait beyond the DOM settling.
    await expect(page.locator('h1')).toHaveText(CONTROL);

    await softNav(page, '/pricing.html');
    await expect(page.locator('h1')).toHaveText(VARIANT);

    // Re-applied from the cookie — same bucket, never re-rolled.
    const cookie = (await page.context().cookies()).find((c) => c.name === '_testa_exp');
    expect(cookie?.value).toContain('17.100');
  });

  test('a hard load of the off-page URL never shows the variant', async ({ page }) => {
    await boot(page, rules, '/pricing.html');
    await expect(page.locator('h1')).toHaveText(VARIANT);

    await boot(page, rules, '/blog.html'); // full reload, cookie already set
    expect(await headline(page)).toBe(CONTROL);
  });
});

test.describe('late-rendered components', () => {
  const rules = [{ match_type: 'contains', url_pattern: '/pricing' }];

  test('a component painted inside the 2s window is changed', async ({ page }) => {
    await boot(page, rules, '/pricing.html');
    await page.evaluate(() => {
      document.querySelector('h1')?.remove();
      setTimeout(() => {
        const h = document.createElement('h1');
        h.innerHTML = 'Late control';
        document.querySelector('main')?.appendChild(h);
      }, 300);
    });
    await expect(page.locator('h1')).toHaveText(VARIANT, { timeout: 3000 });
  });

  test('a component painted after the 2s window is left alone', async ({ page }) => {
    await boot(page, rules, '/pricing.html');
    await page.evaluate(() => {
      document.querySelector('h1')?.remove();
      setTimeout(() => {
        const h = document.createElement('h1');
        h.innerHTML = 'Late control';
        document.querySelector('main')?.appendChild(h);
      }, 2400);
    });
    await page.waitForSelector('h1', { timeout: 5000 });
    await page.waitForTimeout(300);
    expect(await headline(page)).toBe('Late control');
  });
});
