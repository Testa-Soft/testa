/**
 * Cross-domain experiment continuity — 1:1 port of the 3.3.3 `_testa_cd`
 * mechanism (crobot `resources/js/integration/3.3.3/script.js`, the version
 * that introduced cross-domain tracking).
 *
 * The problem it solves: an experiment marked `cross_domain` must show the SAME
 * variation after the visitor follows a link to a different domain — without
 * the destination site re-rolling traffic and possibly landing them in control.
 *
 * How it works (three parts, mirroring 3.3.3):
 *   1. Outbound links to a different domain are tagged, on click, with
 *      `?_testa_cd=<base64({u, exps:[{e,v}]})>` — see `installCrossDomainLinkTagging`.
 *   2. Split-URL redirect destinations that cross a domain get the same param
 *      appended — see `tagUrl`, called from the redirect path in `lifecycle.ts`.
 *   3. On landing, the destination pixel reads the param, applies each carried
 *      assignment (assignment cookie + session bump) so `assign()`'s cookie-first
 *      lookup returns it instead of bucketing — see `applyInboundCrossDomain`.
 *
 * The encoding format is preserved EXACTLY so 3.6/3.3.3 and 4.0 sites
 * interoperate during the rollout window (docs/reference/legacy-pixel-mapping.md).
 *
 * Deviation from 1:1: 3.3.3 also writes the `_testa_uuid` cookie on landing.
 * 4.0 forbids JS writes to `_testa_uuid` (the edge worker owns it — Safari ITP
 * defeat, see cookies.ts). We therefore apply the assignment/session cookies
 * (the load-bearing "don't re-roll" behaviour) and surface the incoming uuid via
 * the injected `onUuid` effect (in-memory `window.Analytica.uuid` mirror), but
 * never write the uuid cookie. Durable uuid stitching stays the worker's `_tu` job.
 *
 * Every exported effectful function takes its side effects / DOM as injected
 * dependencies so the whole module is unit-testable without globals.
 */

import {
  CROSS_DOMAIN_PARAM,
  type CrossDomainAssignment,
  decodeCrossDomain,
  encodeCrossDomainData,
} from '@testa-soft/experiment-core';

// Wire format (encode/decode + the `_testa_cd` param) is shared with the
// middleware via experiment-core so pixel-tagged cross-domain links are honoured
// identically by a pixel-site and a middleware-site. Re-exported for the pixel API.
export { CROSS_DOMAIN_PARAM, encodeCrossDomainData };

/** How often outbound links are re-scanned, mirroring 3.3.3's `setInterval`. */
export const LINK_SCAN_INTERVAL_MS = 2000;

/** A single carried assignment: experiment id + the variation the visitor has. */
export type CrossDomainExperiment = CrossDomainAssignment;

// ─── URL helpers ────────────────────────────────────────────────────────────

/**
 * True when `linkUrl` (resolved against `currentHref`) points at a different
 * host than the current page. Mirrors 3.3.3 `isDifferentDomain`; returns false
 * on unparseable input (degrade to "same domain" → don't tag).
 */
export function isDifferentDomain(linkUrl: string, currentHref: string): boolean {
  try {
    const current = new URL(currentHref).hostname;
    const target = new URL(linkUrl, currentHref).hostname;
    return current !== target;
  } catch {
    return false;
  }
}

/**
 * Return `url` with `_testa_cd` set when it crosses a domain and there is at
 * least one experiment to carry; otherwise return it unchanged. Mirrors 3.3.3
 * `addCrossDomainParamToUrl` + the redirect-path tagging. Never throws.
 */
export function tagUrl(
  url: string,
  currentHref: string,
  experiments: readonly CrossDomainExperiment[],
  uuid: string,
): string {
  if (experiments.length === 0 || !uuid) return url;
  if (!isDifferentDomain(url, currentHref)) return url;
  try {
    const urlObj = new URL(url, currentHref);
    urlObj.searchParams.set(CROSS_DOMAIN_PARAM, encodeCrossDomainData(experiments, uuid));
    return urlObj.toString();
  } catch {
    return url;
  }
}

// ─── eligibility ────────────────────────────────────────────────────────────

export interface EligibilityDeps {
  /** Current assignment for an experiment, or null if none. */
  getAssignment(experimentId: number | string): number | null;
  /** Whether the experiment's session cookie is still fresh. */
  isSessionActive(experimentId: number | string): boolean;
}

/**
 * The experiments whose assignment should be carried across domains: those
 * flagged `cross_domain`, with a current assignment, in an active session.
 * Mirrors 3.3.3 `getCrossDomainExperiments`.
 */
export function eligibleCrossDomainExperiments(
  experiments: ReadonlyArray<{ experiment_id: number | string; cross_domain?: boolean }>,
  deps: EligibilityDeps,
): CrossDomainExperiment[] {
  const out: CrossDomainExperiment[] = [];
  for (const exp of experiments) {
    if (!exp.cross_domain) continue;
    const variationId = deps.getAssignment(exp.experiment_id);
    if (variationId === null) continue;
    if (!deps.isSessionActive(exp.experiment_id)) continue;
    out.push({ experimentId: exp.experiment_id, variationId });
  }
  return out;
}

// ─── inbound apply (landing) ────────────────────────────────────────────────

export interface InboundLocation {
  /** `location.search`, including the leading `?` (or empty). */
  search: string;
  pathname: string;
  hash: string;
}

export interface InboundEffects {
  /** Persist a carried assignment (`cookies.setAssignment`). */
  setAssignment(experimentId: number | string, variationId: number): void;
  /** Bump the experiment's session cookie (`cookies.bumpSession`). */
  bumpSession(experimentId: number | string): void;
  /** Surface the incoming uuid (in-memory mirror only — NOT the uuid cookie). */
  onUuid(uuid: string): void;
}

export interface InboundResult {
  /** Number of assignments applied. */
  applied: number;
  /**
   * The current URL with `_testa_cd` stripped, as a path+query+hash string
   * ready for `history.replaceState`. Null when the param was absent (nothing
   * to clean up).
   */
  cleanedUrl: string | null;
}

/**
 * Read `_testa_cd` from the landing URL and apply each carried assignment.
 * Mirrors 3.3.3 `applyCrossDomainTracking`, minus the forbidden uuid-cookie write.
 *
 * Returns the applied count and the cleaned URL (caller runs `replaceState`).
 */
export function applyInboundCrossDomain(
  loc: InboundLocation,
  effects: InboundEffects,
): InboundResult {
  const params = new URLSearchParams(loc.search);
  const encoded = params.get(CROSS_DOMAIN_PARAM);
  if (!encoded) return { applied: 0, cleanedUrl: null };

  const data = decodeCrossDomain(encoded);

  let applied = 0;
  // Require a uuid (matches the pixel's original contract; a payload with no
  // visitor id carries no continuity).
  if (data?.uuid) {
    effects.onUuid(data.uuid);
    for (const { experimentId, variationId } of data.assignments) {
      const v = Number(variationId);
      if (!Number.isFinite(v)) continue;
      effects.setAssignment(experimentId, v);
      effects.bumpSession(experimentId);
      applied += 1;
    }
  }

  // Always strip the param (even on a malformed payload) so it never leaks into
  // page analytics or gets re-read on an SPA re-eval.
  params.delete(CROSS_DOMAIN_PARAM);
  const query = params.toString();
  const cleanedUrl = `${loc.pathname}${query ? `?${query}` : ''}${loc.hash}`;
  return { applied, cleanedUrl };
}

// ─── outbound link tagging ──────────────────────────────────────────────────

export interface LinkTaggingDeps {
  /** Document to scan. */
  doc: Document;
  /** Fresh eligible experiments, re-read on every scan and every click. */
  eligible(): CrossDomainExperiment[];
  /** Current visitor uuid, or null. */
  getUuid(): string | null;
  /** Current page href (for the different-domain check). */
  currentHref(): string;
  /** Re-scan interval; defaults to `LINK_SCAN_INTERVAL_MS`. */
  intervalMs?: number;
}

const SKIP_PREFIXES = ['#', 'javascript:', 'mailto:', 'tel:'];

/**
 * Install outbound-link tagging. Mirrors 3.3.3 `setupCrossDomainLinkTracking`:
 * scans `a[href]` on load, on an interval, and on DOM mutations; for links to a
 * different domain it attaches a capture-phase click handler that rewrites
 * `href` with a freshly-encoded `_testa_cd` at click time.
 *
 * Returns a teardown that stops the interval, disconnects the observer, and
 * removes every click handler it attached (SPA re-entry / tests must not leak).
 */
export function installCrossDomainLinkTagging(deps: LinkTaggingDeps): () => void {
  const { doc } = deps;
  const intervalMs = deps.intervalMs ?? LINK_SCAN_INTERVAL_MS;
  const processed = new WeakSet<HTMLAnchorElement>();
  const attached: Array<{ link: HTMLAnchorElement; handler: (e: Event) => void }> = [];

  let intervalId: ReturnType<typeof setInterval> | null = null;
  let observer: MutationObserver | null = null;
  let domReadyHandler: (() => void) | null = null;

  const processLinks = (): void => {
    if (deps.eligible().length === 0) return;
    if (!deps.getUuid()) return;

    const links = doc.querySelectorAll<HTMLAnchorElement>('a[href]');
    for (const link of Array.from(links)) {
      if (processed.has(link)) continue;

      const href = link.getAttribute('href');
      if (!href || SKIP_PREFIXES.some((p) => href.startsWith(p))) continue;
      if (!isDifferentDomain(href, deps.currentHref())) continue;

      const originalHref = href;
      const handler = (): void => {
        const uuid = deps.getUuid();
        if (!uuid) return;
        // Only tag if it hasn't been tagged already (idempotent on re-click).
        if (link.href === originalHref || !link.href.includes(CROSS_DOMAIN_PARAM)) {
          link.href = tagUrl(originalHref, deps.currentHref(), deps.eligible(), uuid);
        }
      };
      link.addEventListener('click', handler, { capture: true });
      attached.push({ link, handler });
      processed.add(link);
    }
  };

  const start = (): void => {
    processLinks();
    intervalId = setInterval(processLinks, intervalMs);
    if (typeof MutationObserver !== 'undefined' && doc.body) {
      observer = new MutationObserver(() => processLinks());
      observer.observe(doc.body, { childList: true, subtree: true });
    }
  };

  if (doc.readyState !== 'loading') {
    start();
  } else {
    domReadyHandler = () => start();
    doc.addEventListener('DOMContentLoaded', domReadyHandler);
  }

  return () => {
    if (intervalId !== null) clearInterval(intervalId);
    observer?.disconnect();
    if (domReadyHandler) doc.removeEventListener('DOMContentLoaded', domReadyHandler);
    for (const { link, handler } of attached) {
      link.removeEventListener('click', handler, { capture: true });
    }
    attached.length = 0;
  };
}
