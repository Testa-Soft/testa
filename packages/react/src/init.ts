/**
 * `initTesta` — the client orchestrator. One call runs a full experiment cycle
 * over a `CookieStore` + the current URL:
 *
 *   1. Ensure a visitor id (mint `_testa_uuid` if absent).
 *   2. Preview (`?testa_preview`) → fetch + apply drafts, skip assignment.
 *   3. Otherwise run the engine:
 *      - emit an exposure per fresh enrollment (when tracking is on);
 *      - if a split-URL variation fired, do a CLIENT-side `location.replace`
 *        redirect — on EVERY visit to the control URL (loop safety is the
 *        engine's stateless already-at-destination check, never a marker);
 *      - else apply the assigned DOM changes cookie-first.
 *
 * Returns the applied list + the DOM teardowns (so the caller can dispose them
 * on the next cycle / unmount) + whether a redirect was triggered.
 *
 * Pure over its inputs: `now`, `navigate`, and `fetchImpl` are all injectable,
 * so the whole flow is unit-testable without a real browser navigation.
 */

import type { ProjectConfig } from '@testa-platform/shared-types';
import {
  type Teardown,
  applyVariation,
  emitVariationApplied,
  emitVariationAssigned,
  installTestaGlobal,
} from '@testa-soft/dom';
import {
  ASSIGNMENT_COOKIE,
  type CookieStore,
  SESSION_LENGTH_SEC,
  UUID_COOKIE,
  UUID_TTL_SEC,
  isCrawlerUserAgent,
  maybeMigrateLegacyCookies,
  resolveExposures,
} from '@testa-soft/experiment-core';
import { type VariationAppliedEvent, runExperiments } from '@testa-soft/experiment-core';
import { applyAssignedExperiments } from './apply-assignments.ts';
import { startGoalTracking } from './goal-tracking.ts';
import {
  PREVIEW_FLAG,
  PREVIEW_TOKEN,
  PREVIEW_VARIATION_ID,
  fetchPreviewChanges,
  getPreviewToken,
  isPreviewRequested,
} from './preview.ts';
import { DEFAULT_TRACKING_HOST, emitExposure } from './tracking.ts';

export interface InitOptions {
  config: ProjectConfig;
  /** The absolute URL of the current page (e.g. `window.location.href`). */
  currentUrl: string;
  store: CookieStore;
  /**
   * Backend base URL for preview mode (`/api/preview/<token>`). Defaults to
   * the tracking host — the same crobot backend exposures are posted to — so
   * `?testa_preview` works without configuration, matching the pixel (which
   * reads it from `cfPrefill.apiUrl`). Override only for a self-hosted backend.
   */
  previewApiUrl?: string;
  /** Emit exposures on fresh enrollment. Default true. */
  tracking?: boolean;
  /** Host for exposure tracking. Default `DEFAULT_TRACKING_HOST`. */
  trackingHost?: string;
  /** Clock, injectable for tests. Default `Date.now()`. */
  now?: number;
  /** Redirect action, injectable for tests. Default `window.location.replace`. */
  navigate?: (url: string) => void;
  /** Fetch impl for preview, injectable for tests. Default global `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * Provenance stamped on every exposure this cycle reports — see
   * `ExposurePayload.source`. Defaults to `client:initial` for the first cycle
   * of a page load and `client:spa` for the ones a soft navigation triggers.
   */
  source?: string;
  /**
   * Run experiments for crawlers too. Default false — the same policy the proxy
   * applies with `skipBots`, and it has to be applied here as well: a crawler
   * that executes JavaScript (AdsBot-Google renders pages) is bypassed
   * server-side and would otherwise be bucketed by this engine — minting a
   * visitor id, writing an assignment and firing an exposure that skews the
   * results it was excluded from.
   */
  includeBots?: boolean;
  /** UA to judge. Defaults to `navigator.userAgent`. */
  userAgent?: string | null;
  /**
   * May this cycle perform the split-URL redirect? Default true.
   *
   * A redirect is the one change type that cannot be retried or undone: a DOM
   * change re-applies harmlessly when the page settles, a navigation commits
   * once and takes the address bar with it. So it must only ever fire on a URL
   * that arrived over the wire — the initial document load — and never on a URL
   * the application assembled during a soft navigation, which may still be
   * mid-assembly (a query rebuilt from router state that is not ready yet).
   *
   * Callers running a cycle per soft navigation pass `false` for every cycle
   * after the first. Assignment, DOM changes and tracking are unaffected.
   */
  allowRedirect?: boolean;
  /**
   * May this cycle DECIDE — bucket a visitor, write an assignment? Default true.
   *
   * Same reasoning as `allowRedirect`, one step earlier. On a soft navigation
   * the URL is not something the browser delivered, it is something the
   * application assembled, and it can be observed part-built: a query rebuilt
   * from router state that is not ready yet arrives empty. Deciding against it
   * evaluates every page rule and exclusion on a URL the visitor never actually
   * had — so a rule that should have kept them out silently misses, and the
   * assignment it writes is sticky.
   *
   * With this false the cycle is strictly COOKIE-FIRST: it applies whatever is
   * already assigned, reports exposures, arms goals. It never buckets. Deciding
   * on a soft navigation belongs to the proxy, which only ever sees URLs that
   * came over the wire.
   */
  allowAssign?: boolean;
  /**
   * TEMPORARY, for a site cutting over from the legacy crobot pixel while
   * experiments are LIVE: adopt a returning visitor's legacy 3.x cookies into
   * the packed `_testa_exp` cookie before anything reads it. Mirrors the proxy's
   * `legacyCookiesEnabled` and must be set to the SAME value — a pageview the
   * proxy passed through (cold instance, `decisions: 'client'`) is decided here,
   * and would otherwise re-bucket the visitor the proxy would have carried over.
   *
   * This side also reaches the legacy localStorage MIRROR, which the server
   * cannot see: 3.x wrote every cookie to both, so a visitor whose cookie jar
   * was cleared can still be recovered here.
   *
   * See `experiment-core/legacy-migration.ts` for what it reads and when it
   * stops doing anything.
   */
  legacyCookiesEnabled?: boolean;
}

export interface InitResult {
  /** Every variation applied on this run (control + variant). */
  applied: VariationAppliedEvent[];
  /** DOM teardowns to dispose on the next cycle / unmount. Empty on redirect/preview-miss. */
  teardowns: Teardown[];
  /** True when a client-side redirect was triggered (the page is navigating away). */
  redirected: boolean;
}

export async function initTesta(opts: InitOptions): Promise<InitResult> {
  const { config, currentUrl, store } = opts;
  const trackingEnabled = opts.tracking ?? true;
  const trackingHost = opts.trackingHost ?? DEFAULT_TRACKING_HOST;
  const now = opts.now ?? Date.now();
  const navigate = opts.navigate ?? defaultNavigate;
  const source = opts.source ?? ((opts.allowAssign ?? true) ? 'client:initial' : 'client:spa');
  const search = searchOf(currentUrl);

  // Crawlers: no visitor id, no assignment, no exposure — mirrors the proxy's
  // `skipBots`. Returns cleanly so the caller still reveals the shield: a
  // crawler must see the control page, never a hidden one.
  const userAgent =
    opts.userAgent ?? (typeof navigator === 'undefined' ? null : navigator.userAgent);
  if (!(opts.includeBots ?? false) && isCrawlerUserAgent(userAgent)) {
    return { applied: [], teardowns: [], redirected: false };
  }

  const visitorId = ensureVisitorId(store);

  // ── Preview: skip assignment, fetch + apply drafts ──────────────────────
  if (isPreviewRequested(search)) {
    const token = getPreviewToken(search);
    const teardowns: Teardown[] = [];
    // Falls back to the tracking host so preview needs no configuration; the
    // pixel gets the same URL from `cfPrefill.apiUrl`.
    const previewApiUrl = opts.previewApiUrl ?? opts.trackingHost ?? DEFAULT_TRACKING_HOST;
    if (token) {
      const changes = await fetchPreviewChanges(previewApiUrl, token, opts.fetchImpl ?? fetch);
      if (changes.length > 0) teardowns.push(...applyVariation(PREVIEW_VARIATION_ID, changes));
    } else {
      // Preview mode suppresses the normal cycle, so an unusable preview would
      // otherwise render a page with NOTHING applied and no explanation. Warned
      // in every environment, not just dev: preview links are opened against
      // production, which is exactly where the explanation is needed. It can
      // never reach a normal visitor — it requires `?testa_preview` in the URL.
      console.warn(
        `[testa] ?${PREVIEW_FLAG} is set but ?${PREVIEW_TOKEN} is missing — no ` +
          'draft changes can be fetched, and normal experiments are skipped in ' +
          'preview mode. Open the preview link from the dashboard.',
      );
    }
    return { applied: [], teardowns, redirected: false };
  }

  // ── GUARDRAIL: no persisted visitor id → decide NOTHING ─────────────────
  // Bucketing is `xxhash32(visitorId:experimentId) % 100`, so an empty id is
  // not "random", it is a CONSTANT: every visitor in this state lands in the
  // same variation for a given experiment, and lands there again on every
  // pageview because nothing was stored. That is worse than not running at all
  // — it manufactures a one-sided, self-repeating population. The visitor sees
  // the control, which is the correct default for a client we cannot identify.
  if (!visitorId) {
    return { applied: [], teardowns: [], redirected: false };
  }

  // TEMPORARY (legacy cutover) — carry a returning 3.x visitor's assignment into
  // the packed cookie before ANYTHING reads it. Deliberately outside the
  // `decide` gate below: this is not a decision, it is repairing storage, and a
  // cookie-first soft-nav cycle needs the migrated assignment just as much as a
  // deciding one does. See experiment-core/legacy-migration.ts.
  maybeMigrateLegacyCookies(
    opts.legacyCookiesEnabled,
    { nowMs: now, sessionLengthSec: SESSION_LENGTH_SEC },
    store,
  );

  // ── Decide, unless the caller withheld permission ───────────────────────
  // A cookie-first cycle skips the engine entirely: nothing is bucketed and no
  // rule is evaluated against a URL the application built. Everything below —
  // apply, exposures, goals — runs off the packed cookie either way.
  const decide = opts.allowAssign ?? true;
  const result = decide
    ? runExperiments(
        {
          config,
          currentUrl,
          visitorId,
          now,
          getCookie: (n) => store.get(n),
          // Visitor geo spliced into the config by the config-geo edge worker.
          // Gates targeting AND exclusions for every experiment type. Absent/empty
          // → dimension unsupported: targeting fails closed, exclusions fail open.
          ...(config.geo?.country ? { country: config.geo.country } : {}),
        },
        store,
      )
    : { applied: [], redirectTo: undefined };

  installTestaGlobal();

  if (decide) {
    // `variation_assigned` at DECISION time — BEFORE any redirect, while the
    // page is still alive. This is the hook a listener needs to send its own
    // tracking (3.3.3 `script.js` parity): `variation_applied` fires only after
    // the DOM apply, which a split-URL visitor never reaches — they are already
    // navigating. The bus replays history, so a handler registered later still
    // receives it.
    if (config.project_id != null) {
      for (const applied of result.applied) {
        emitVariationAssigned({
          project_id: config.project_id,
          experiment: applied.experimentId,
          variation: applied.variationId,
          uuid: applied.visitorId,
          ...(applied.title ? { title: applied.title } : {}),
          url: applied.url,
        });
      }
    }

    // Report BEFORE any redirect — a split-URL visitor leaves this page before
    // the apply step below ever runs, so this is their only chance to be
    // counted. The transport dedups per load.
    if (trackingEnabled && config.project_id != null) {
      for (const applied of result.applied) {
        void emitExposure(trackingHost, {
          project_id: config.project_id,
          experiment: applied.experimentId,
          variation: applied.variationId,
          uuid: applied.visitorId,
          ...(applied.title ? { title: applied.title } : {}),
          url: applied.url,
          source,
        });
      }
    }

    // ── Split-URL: client-side redirect ──────────────────────────────────
    if (result.redirectTo && (opts.allowRedirect ?? true)) {
      navigate(result.redirectTo);
      return { applied: result.applied, teardowns: [], redirected: true };
    }
  }

  // ── DOM: apply the assigned variant, cookie-first — page-gated AND
  // exclusion-gated (3.3.3 parity: exclusions re-checked every pageview), so a
  // variant assigned on the experiment page never leaks onto other routes and
  // a mutually-excluded experiment never double-applies ──────────────────────
  const assignmentCookie = store.get(ASSIGNMENT_COOKIE);
  const teardowns = applyAssignedExperiments(config, assignmentCookie, currentUrl, {
    url: currentUrl,
    getCookie: (n) => store.get(n),
    ...(typeof navigator !== 'undefined' ? { userAgent: navigator.userAgent } : {}),
    ...(config.geo?.country ? { country: config.geo.country } : {}),
  });

  // Fire `variation_applied` for each exposed experiment on this page (client
  // event surface + GTM dataLayer). Deduped per load inside the bus.
  const uuid = store.get(UUID_COOKIE) ?? '';
  const nowSec = Math.floor(now / 1000);
  for (const e of resolveExposures(config, assignmentCookie, currentUrl, nowSec)) {
    if (config.project_id == null) continue;
    const payload = {
      project_id: config.project_id,
      experiment: e.experimentId,
      variation: e.variationId,
      uuid,
      ...(e.title ? { title: e.title } : {}),
      url: currentUrl,
    };
    emitVariationApplied(payload);
    // Count here too: a visitor the server could not identify (no cookie on the
    // request) is counted by nobody else, and this is the id that will persist.
    if (trackingEnabled) void emitExposure(trackingHost, { ...payload, source });
  }

  // Arm goal tracking (page_view / click / custom) for every assigned,
  // session-live experiment — NOT page-gated: a goal usually completes on a
  // different page than the experiment runs on. Conversions POST the legacy
  // `/api/leads/convert` payload; the teardown re-arms cleanly on SPA nav.
  teardowns.push(
    startGoalTracking(config, assignmentCookie, currentUrl, uuid, trackingHost, nowSec),
  );

  return { applied: result.applied, teardowns, redirected: false };
}

/**
 * Return the existing visitor id, or mint + persist a new one. Empty string
 * when the id could NOT be persisted.
 *
 * The read-back is the point. A minted id that the browser refused to store is
 * worthless: the next pageview mints another one, so the visitor is a new
 * visitor every time and is re-bucketed every time. Reporting that as `''`
 * lets the caller decline to decide instead of deciding on sand.
 */
export function ensureVisitorId(store: CookieStore): string {
  const existing = store.get(UUID_COOKIE);
  if (existing) return existing;
  const uuid = crypto.randomUUID();
  store.set(UUID_COOKIE, uuid, { maxAgeSec: UUID_TTL_SEC });
  return store.get(UUID_COOKIE) ?? '';
}

function defaultNavigate(url: string): void {
  if (typeof window !== 'undefined') window.location.replace(url);
}

function searchOf(url: string): string {
  try {
    return new URL(url).search;
  } catch {
    return '';
  }
}
