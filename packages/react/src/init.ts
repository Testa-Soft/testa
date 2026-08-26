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
  UUID_COOKIE,
  UUID_TTL_SEC,
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
  const search = searchOf(currentUrl);

  ensureVisitorId(store);

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

  // ── Normal: run the engine ──────────────────────────────────────────────
  const result = runExperiments(
    {
      config,
      currentUrl,
      visitorId: store.get(UUID_COOKIE) ?? '',
      now,
      getCookie: (n) => store.get(n),
      // Visitor geo spliced into the config by the config-geo edge worker.
      // Gates targeting AND exclusions for every experiment type. Absent/empty
      // → dimension unsupported: targeting fails closed, exclusions fail open.
      ...(config.geo?.country ? { country: config.geo.country } : {}),
    },
    store,
  );

  // `variation_assigned` at DECISION time — BEFORE any redirect, while the page
  // is still alive. This is the hook a listener needs to send its own tracking
  // (3.3.3 `script.js` parity): `variation_applied` fires only after the DOM
  // apply, which a split-URL visitor never reaches — they are already
  // navigating. The bus replays history, so a handler registered later still
  // receives it.
  installTestaGlobal();
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

  // Emit an exposure once per fresh enrollment (deduped server-side anyway).
  if (trackingEnabled) {
    for (const applied of result.applied) {
      if (applied.firstAssignment && config.project_id != null) {
        void emitExposure(trackingHost, {
          project_id: config.project_id,
          experiment: applied.experimentId,
          variation: applied.variationId,
          uuid: applied.visitorId,
          ...(applied.title ? { title: applied.title } : {}),
          url: applied.url,
        });
      }
    }
  }

  // ── Split-URL: client-side redirect — ALWAYS, on every visit to the control
  // URL. Loop safety is the engine's stateless already-at-destination check,
  // never a marker cookie (a marker would show variant visitors the control
  // page on later visits). ─────────────────────────────────────────────────
  if (result.redirectTo) {
    navigate(result.redirectTo);
    return { applied: result.applied, teardowns: [], redirected: true };
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
    if (config.project_id != null) {
      emitVariationApplied({
        project_id: config.project_id,
        experiment: e.experimentId,
        variation: e.variationId,
        uuid,
        ...(e.title ? { title: e.title } : {}),
        url: currentUrl,
      });
    }
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

/** Return the existing visitor id, or mint + persist a new one. */
export function ensureVisitorId(store: CookieStore): string {
  const existing = store.get(UUID_COOKIE);
  if (existing) return existing;
  const uuid = crypto.randomUUID();
  store.set(UUID_COOKIE, uuid, { maxAgeSec: UUID_TTL_SEC });
  return uuid;
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
