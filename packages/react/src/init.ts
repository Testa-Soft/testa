/**
 * `initTesta` — the client orchestrator. One call runs a full experiment cycle
 * over a `CookieStore` + the current URL:
 *
 *   1. Ensure a visitor id (mint `_testa_uuid` if absent).
 *   2. Preview (`?testa_preview`) → fetch + apply drafts, skip assignment.
 *   3. Otherwise run the engine:
 *      - emit an exposure per fresh enrollment (when tracking is on);
 *      - if a split-URL variation fired, do a CLIENT-side `location.replace`
 *        redirect, loop-guarded by the per-experiment `_testa_redirected_<id>`
 *        cookie so we never bounce back and forth;
 *      - else apply the assigned DOM changes cookie-first.
 *
 * Returns the applied list + the DOM teardowns (so the caller can dispose them
 * on the next cycle / unmount) + whether a redirect was triggered.
 *
 * Pure over its inputs: `now`, `navigate`, and `fetchImpl` are all injectable,
 * so the whole flow is unit-testable without a real browser navigation.
 */

import type { ProjectConfig } from '@testa-platform/shared-types';
import { type Teardown, applyVariation } from '@testa-soft/dom';
import {
  ASSIGNMENT_COOKIE,
  type CookieStore,
  UUID_COOKIE,
  UUID_TTL_SEC,
  hasRedirected,
  markRedirected,
} from '@testa-soft/experiment-core';
import { type VariationAppliedEvent, runExperiments } from '@testa-soft/experiment-core';
import { applyAssignedExperiments } from './apply-assignments.ts';
import {
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
  /** Backend base URL for preview mode; required for `?testa_preview` to fetch drafts. */
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
    if (token && opts.previewApiUrl) {
      const changes = await fetchPreviewChanges(opts.previewApiUrl, token, opts.fetchImpl ?? fetch);
      if (changes.length > 0) teardowns.push(...applyVariation(PREVIEW_VARIATION_ID, changes));
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
    },
    store,
  );

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

  // ── Split-URL: client-side redirect, loop-guarded ───────────────────────
  if (result.redirectTo) {
    const redirectEvent = result.applied.find((a) => a.redirected);
    const expId = redirectEvent?.experimentId;
    const alreadyBounced = expId != null && hasRedirected(store, expId);
    if (!alreadyBounced) {
      if (expId != null) markRedirected(store, expId);
      navigate(result.redirectTo);
      return { applied: result.applied, teardowns: [], redirected: true };
    }
  }

  // ── DOM: apply the assigned variant, cookie-first ───────────────────────
  const teardowns = applyAssignedExperiments(config, store.get(ASSIGNMENT_COOKIE));
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
