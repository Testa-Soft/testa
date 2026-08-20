'use client';

/**
 * `<TestaExperiments/>` — applies the visitor's DOM experiments on the client.
 * Add it once in the layout (client component); it re-applies on each App-Router
 * navigation.
 *
 * Two modes:
 *   - Normal (cookie-first): the middleware already bucketed the visitor
 *     server-side and wrote `_testa_exp`; this reads that cookie and applies the
 *     variant's DOM changes via the shared apply engine — no re-bucket.
 *   - Preview (`?testa_preview=true&testa_preview_token=<t>`): skips assignment,
 *     fetches the draft changes for that session from `previewApiUrl` and applies
 *     them, so an editor can see un-published changes live.
 *
 * Either way it reveals the anti-flicker shield (raised by `<TestaShield/>`) once
 * applied, so control content is never shown before the variant.
 *
 * Framework-agnostic logic lives in `apply-assignments.ts` + `preview.ts` (unit
 * tested); this file is the React + App-Router glue.
 */

import type { ProjectConfig } from '@testa-platform/shared-types';
import {
  type Teardown,
  applyVariation,
  emitVariationApplied,
  installTestaGlobal,
} from '@testa-soft/dom';
import { ASSIGNMENT_COOKIE, UUID_COOKIE, resolveExposures } from '@testa-soft/experiment-core';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { readClientCookie } from '../client-cookie.ts';
import { DEFAULT_TRACKING_HOST } from '../constants.ts';
import { applyAssignedExperiments, revealShield } from './apply-assignments.ts';
import { startGoalTracking } from './goal-tracking.ts';
import {
  PREVIEW_VARIATION_ID,
  fetchPreviewChanges,
  getPreviewToken,
  isPreviewRequested,
} from './preview.ts';

export interface TestaExperimentsProps {
  /** The same ProjectConfig the middleware uses (local fixture or fetched once). */
  config: ProjectConfig;
  /**
   * Backend base URL for preview mode (crobot) — where `/api/preview/{token}`
   * lives. Required for `?testa_preview` to fetch drafts; ignored otherwise.
   */
  previewApiUrl?: string;
  /**
   * crobot base URL for goal conversions (`/api/leads/convert`) — same host the
   * middleware posts exposures to. Defaults to the SDK's tracking host.
   */
  trackingHost?: string;
}

export function TestaExperiments({
  config,
  previewApiUrl,
  trackingHost,
}: TestaExperimentsProps): null {
  const pathname = usePathname();

  // `pathname` is intentionally a dependency: it's the re-apply trigger on
  // App-Router soft navigation, even though it isn't read in the effect body.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the re-run trigger
  useEffect(() => {
    let cancelled = false;
    const teardowns: Teardown[] = [];
    const dispose = () => {
      cancelled = true;
      for (const teardown of teardowns) {
        try {
          teardown();
        } catch {
          // never let a teardown break unmount / the next cycle
        }
      }
    };

    const search = typeof window !== 'undefined' ? window.location.search : '';

    if (isPreviewRequested(search)) {
      // Preview: skip assignment, fetch + apply drafts. Best-effort.
      const token = getPreviewToken(search);
      if (token && previewApiUrl) {
        void fetchPreviewChanges(previewApiUrl, token).then((changes) => {
          if (!cancelled && changes.length > 0) {
            teardowns.push(...applyVariation(PREVIEW_VARIATION_ID, changes));
          }
          revealShield();
        });
      } else {
        revealShield();
      }
      return dispose;
    }

    // Normal: apply the assigned variant, cookie-first — but only on pages that
    // match the experiment's page rule (keyed on `pathname` so a soft nav to a
    // non-matching route tears the change down instead of leaking it everywhere)
    // AND only when no exclusion rule matches this pageview (3.3.3
    // `handleExclusions` parity — mutual `experiment` exclusions included).
    // NOTE: no `country` here — a server-fetched config's geo is the
    // datacenter's; geo exclusions are the middleware's job per request.
    const currentUrl = typeof window !== 'undefined' ? window.location.href : '';
    const assignmentCookie = readClientCookie(ASSIGNMENT_COOKIE);
    teardowns.push(
      ...applyAssignedExperiments(config, assignmentCookie, currentUrl, {
        url: currentUrl,
        getCookie: readClientCookie,
        ...(typeof navigator !== 'undefined' ? { userAgent: navigator.userAgent } : {}),
      }),
    );
    revealShield();

    // Fire `variation_applied` for every experiment the visitor is exposed to on
    // this page (split-URL, DOM, and control alike) — once per load, deduped in
    // the bus. This is the client event surface + the GTM dataLayer push.
    installTestaGlobal();
    const uuid = readClientCookie(UUID_COOKIE) ?? '';
    const nowSec = Math.floor(Date.now() / 1000);
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
    // `/api/leads/convert` payload; teardown re-arms cleanly on soft nav.
    teardowns.push(
      startGoalTracking(
        config,
        assignmentCookie,
        currentUrl,
        uuid,
        trackingHost ?? DEFAULT_TRACKING_HOST,
        nowSec,
      ),
    );
    return dispose;
    // Keyed on `config.config_hash` (a stable string), NOT the `config` object —
    // so a caller passing an inline config, a dev Fast Refresh, or a parent
    // re-render doesn't re-run the effect and stack duplicate inserts. Re-runs
    // only on a real config change or route change (pathname).
  }, [config.config_hash, pathname, previewApiUrl, trackingHost]);

  return null;
}
