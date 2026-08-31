/**
 * Config API — `/api/v1/config/:projectId`.
 *
 *   POST  The upstream calls this on every change (from GenerateProjectScriptHandler),
 *         sending its project JSON (ProjectResource shape). The collector BUILDS
 *         the servable ProjectConfig via `buildTestaConfig` and STORES it.
 *   GET   serves the stored ProjectConfig — this is what @testa/next points its
 *         `configUrl` at, making testa-platform the single source of truth.
 *
 * v1 deliverable: build + save as-is. No auth yet (mirrors the upstream's own public
 * config endpoints); a shared secret is a fast follow.
 */

import type { Context } from 'hono';
import { z } from 'zod';
import { type TestaConfigSource, buildTestaConfig } from './build.ts';
import type { ConfigStore } from './store.ts';

export interface ConfigRouteDeps {
  store: ConfigStore;
  /** ISO clock, injectable for tests. */
  now?: () => string;
  /** Shared secret required to WRITE config (Bearer token). Omit to disable auth. */
  writeToken?: string;
}

/** Constant-time-ish bearer check. */
function isAuthorized(header: string | undefined, token: string | undefined): boolean {
  if (!token) return true; // auth disabled (dev/tests without a token)
  const prefix = 'Bearer ';
  if (!header || !header.startsWith(prefix)) return false;
  const provided = header.slice(prefix.length);
  if (provided.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= provided.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

// Minimal boundary validation of the upstream project JSON — only the fields the
// adapter reads. `.passthrough()` keeps the upstream's extra fields without failing.
const changeSchema = z
  .object({
    url_match_type: z.string().nullish(),
    content: z.string().nullish(),
    type: z.string().optional(),
  })
  .passthrough();

const variationSchema = z
  .object({
    identifier: z.number(),
    traffic: z.number(),
    url_match_type: z.string().nullish(),
    changes: z.array(changeSchema).default([]),
  })
  .passthrough();

const ruleSchema = z
  .object({
    type: z.string(),
    value: z.string().nullish(),
    operator: z.string().nullish(),
  })
  .passthrough();

const experimentSchema = z
  .object({
    identifier: z.number(),
    title: z.string().optional(),
    url: z.string(),
    url_match_type: z.string(),
    // Split-URL delivery mode; only 'rewrite' changes behaviour (see build.ts).
    nav: z.string().nullish(),
    traffic: z.number(),
    type: z.string(),
    status: z.string(),
    cross_domain: z.union([z.number(), z.boolean()]).optional(),
    targeting: z.array(ruleSchema).optional(),
    exclusions: z.array(ruleSchema).optional(),
    variations: z.array(variationSchema).default([]),
  })
  .passthrough();

const sourceSchema = z
  .object({
    id: z.number(),
    name: z.string().optional(),
    experiments: z.array(experimentSchema).default([]),
  })
  .passthrough();

export function makeConfigPutHandler(deps: ConfigRouteDeps) {
  const now = deps.now ?? (() => new Date().toISOString());

  return async (c: Context): Promise<Response> => {
    if (!isAuthorized(c.req.header('authorization'), deps.writeToken)) {
      return c.json({ ok: false, error: 'unauthorized' }, 401);
    }

    const projectId = c.req.param('projectId');
    if (!projectId) return c.json({ ok: false, error: 'missing projectId' }, 400);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: 'invalid JSON body' }, 400);
    }

    const parsed = sourceSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { ok: false, error: 'expected a project JSON', issues: parsed.error.issues },
        422,
      );
    }

    // Validated by zod above; the cast reconciles zod's `string | undefined`
    // optionals with the adapter's `?:` optionals under exactOptionalPropertyTypes.
    const config = buildTestaConfig(parsed.data as TestaConfigSource, {
      slug: projectId,
      publishedAt: now(),
    });

    try {
      await deps.store.put(projectId, config);
    } catch (err) {
      console.error('[config] store.put failed', { projectId, err: (err as Error).message });
      return c.json({ ok: false, error: 'failed to store config' }, 503);
    }

    return c.json(
      {
        ok: true,
        project_id: config.project_id,
        slug: config.slug,
        config_hash: config.config_hash,
        experiments: config.experiments.length,
      },
      200,
    );
  };
}

export function makeConfigGetHandler(deps: ConfigRouteDeps) {
  return async (c: Context): Promise<Response> => {
    const projectId = c.req.param('projectId');
    if (!projectId) return c.json({ ok: false, error: 'missing projectId' }, 400);

    let config: Awaited<ReturnType<ConfigStore['get']>>;
    try {
      config = await deps.store.get(projectId);
    } catch (err) {
      console.error('[config] store.get failed', { projectId, err: (err as Error).message });
      // Never let an error response be cached (CDN or client) — a transient blip
      // must not stick. Pair with a CF cache rule that respects origin cache-control.
      c.header('Cache-Control', 'no-store');
      return c.json({ ok: false, error: 'failed to read config' }, 503);
    }

    // A not-yet-published project 404s; do NOT cache it, or the config stays
    // "missing" at the edge until TTL even after the first publish.
    if (!config) {
      c.header('Cache-Control', 'no-store');
      return c.json({ ok: false, error: 'config not found' }, 404);
    }

    // ETag = config_hash so Cloudflare (and clients) can revalidate cheaply.
    // Purge-on-publish (crobot) is the authoritative invalidation, so the CF
    // edge may hold the config for long: `s-maxage` (shared caches only) keeps
    // PoPs warm for 10min + a 30min stale-while-revalidate window, killing the
    // cold-origin round trip for all but the quietest PoPs. Browsers get the
    // short `max-age` safety net (the config-geo worker rewrites the
    // browser-facing header to `private` anyway).
    const etag = `"${config.config_hash}"`;
    c.header('ETag', etag);
    c.header('Cache-Control', 'public, max-age=30, s-maxage=600, stale-while-revalidate=1800');
    if (c.req.header('if-none-match') === etag) return c.body(null, 304);

    return c.json(config, 200);
  };
}
