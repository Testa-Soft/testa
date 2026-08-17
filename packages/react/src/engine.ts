/**
 * Host-neutral experiment decision engine for the client SDK. No `window` /
 * `document` import — pure over a `CookieStore` + request context, fully
 * unit-testable with fakes. Shares the exact orchestration of the middleware's
 * engine (`@testa-soft/next`) so a visitor buckets identically whichever host
 * they hit; only the redirect *action* differs (the caller does a client-side
 * `location.replace`, not a server 307).
 *
 * Assigns BOTH split-URL (redirect) and DOM (css/html/text/…) experiments in one
 * pass: it always buckets + writes the sticky `_testa_exp` cookie so the
 * assignment is fixed, and only *flags* a redirect when the assigned variation
 * carries a redirect change. DOM changes aren't applied here — `initTesta` reads
 * the same cookie and applies them cookie-first (no re-bucket).
 *
 * Per call:
 *   0. Apply inbound cross-domain assignments (`?_testa_cd=…`).
 *   1. For each ACTIVE experiment:
 *      a. Page gate — only enroll when the current URL matches the page rule.
 *      b. Entry gates (ONLY when not yet assigned — cookie-first wins):
 *         exclusions (any match → skip), targeting (must be eligible, AND).
 *      c. Assign (cookie-first + deterministic bucket) into packed `_testa_exp`.
 *      d. Emit a `variation_applied` event.
 *      e. If the assigned variation is a redirect, resolve the destination and
 *         flag it. First redirect wins; DOM-only experiments fall through.
 */

import type { ExperimentRule, ProjectConfig, VariationConfig } from '@testa-platform/shared-types';
import {
  CROSS_DOMAIN_PARAM,
  type CookieStore,
  type RedirectChange,
  type TargetingContext,
  applyAssignment,
  assign,
  decodeCrossDomain,
  hasCachedAssignment,
  isExcludedByRules,
  matchesForMode,
  passesTargeting,
  resolveRedirectDestination,
} from '@testa-soft/experiment-core';

/** Payload emitted for each variation applied on a run (control + variant). */
export interface VariationAppliedEvent {
  experimentId: number;
  variationId: number;
  /** Experiment title, when set (for the exposure payload / listener). */
  title?: string;
  /** True when the applied variation triggered a redirect. */
  redirected: boolean;
  /** Resolved destination URL, present when `redirected`. */
  destinationUrl?: string;
  visitorId: string;
  /** The URL the variation was applied on. */
  url: string;
  /** True when freshly bucketed on this run; false when served from the sticky cookie. */
  firstAssignment: boolean;
}

export interface EngineResult {
  /** Destination to client-redirect to, if a split-URL experiment fired. */
  redirectTo?: string;
  /** Every variation applied on this run (control + variant), in order. */
  applied: VariationAppliedEvent[];
}

export interface EngineContext {
  config: ProjectConfig;
  currentUrl: string;
  visitorId: string;
  now: number;
  /** Read a cookie (for `cookie` targeting). */
  getCookie: (name: string) => string | null;
  userAgent?: string;
  /** ISO country code, when available. */
  country?: string;
}

export function runExperiments(ctx: EngineContext, store: CookieStore): EngineResult {
  const applied: VariationAppliedEvent[] = [];
  applyInboundCrossDomain(ctx.currentUrl, ctx.config, store);

  const targetingCtx: TargetingContext = {
    url: ctx.currentUrl,
    getCookie: ctx.getCookie,
    ...(ctx.userAgent !== undefined ? { userAgent: ctx.userAgent } : {}),
    ...(ctx.country !== undefined ? { country: ctx.country } : {}),
  };

  for (const experiment of ctx.config.experiments) {
    if (experiment.status !== 'active') continue;

    // a. Page gate — only enroll on the experiment's page.
    if (!matchesPageRule(ctx.currentUrl, experiment.rules)) continue;

    // b. Entry gates — ONLY for a visitor not yet assigned. Cookie-first wins:
    // a returning enrolled visitor stays in even if their utm/etc. changed.
    if (!hasCachedAssignment(store, experiment.experiment_id)) {
      if (isExcludedByRules(experiment.exclusions, targetingCtx)) continue;
      if (!passesTargeting(experiment.targeting, targetingCtx)) continue;
    }

    // c. Assign (packed `_testa_exp` — same format as the middleware + pixel).
    const result = assign(
      {
        experiment_id: experiment.experiment_id,
        traffic_allocation: experiment.traffic_allocation,
        variations: experiment.variations.map((v) => ({
          variation_id: v.variation_id,
          weight: v.weight,
        })),
      },
      { visitorId: ctx.visitorId, now: ctx.now },
      store,
    );
    if (result.isExcluded) continue;

    // d/e. Resolve redirect (if the applied variation is a redirect) + emit event.
    const variation = experiment.variations.find((v) => v.variation_id === result.variationId);
    const change = variation ? redirectChangeOf(variation) : undefined;
    const dest = change ? resolveRedirectDestination(change, ctx.currentUrl) : undefined;
    const redirected = Boolean(dest?.shouldRedirect && dest.finalUrl);

    applied.push({
      experimentId: experiment.experiment_id,
      variationId: result.variationId,
      ...(experiment.title ? { title: experiment.title } : {}),
      redirected,
      ...(redirected && dest?.finalUrl ? { destinationUrl: dest.finalUrl } : {}),
      visitorId: ctx.visitorId,
      url: ctx.currentUrl,
      firstAssignment: !result.fromCookie,
    });

    if (redirected && dest?.finalUrl) {
      return { redirectTo: dest.finalUrl, applied };
    }
  }

  return { applied };
}

function applyInboundCrossDomain(url: string, config: ProjectConfig, store: CookieStore): void {
  const q = url.indexOf(`${CROSS_DOMAIN_PARAM}=`);
  if (q === -1) return;
  let raw: string;
  try {
    raw = new URL(url, 'https://placeholder.invalid').searchParams.get(CROSS_DOMAIN_PARAM) ?? '';
  } catch {
    return;
  }
  const payload = decodeCrossDomain(raw);
  if (!payload) return;
  const crossDomainIds = new Set(
    config.experiments.filter((e) => e.cross_domain).map((e) => Number(e.experiment_id)),
  );
  for (const a of payload.assignments) {
    if (crossDomainIds.has(Number(a.experimentId))) {
      applyAssignment(store, a.experimentId, a.variationId);
    }
  }
}

function matchesPageRule(url: string, rules: ExperimentRule[]): boolean {
  if (!rules || rules.length === 0) return true;
  return rules.every((r) => matchesRule(url, r));
}

function matchesRule(url: string, rule: ExperimentRule): boolean {
  if (rule.match_type === 'not_contains') return !url.includes(rule.url_pattern);
  const mode =
    rule.match_type === 'contains' ? 'contains' : rule.match_type === 'regex' ? 'regex' : 'exact';
  return matchesForMode(url, rule.url_pattern, mode);
}

function redirectChangeOf(variation: VariationConfig): RedirectChange | undefined {
  return variation.changes.find((c): c is RedirectChange => c.type === 'redirect');
}
