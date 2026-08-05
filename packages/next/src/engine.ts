/**
 * Host-neutral split-URL decision engine. No Next import — pure over a
 * `CookieStore` + request context, fully unit-testable with fakes.
 *
 * Per request, in split-URL order:
 *   0. Apply inbound cross-domain assignments (`?_testa_cd=…`) so a visitor
 *      carried from another domain keeps their variation.
 *   1. For each ACTIVE experiment with a redirect variation:
 *      a. Page gate — only enroll when the current URL matches the experiment's
 *         page rule (experiment's own match mode). No enrollment off-page.
 *      b. Entry gates (ONLY for a visitor not yet assigned — cookie-first wins,
 *         so a returning enrolled visitor is never re-gated by targeting):
 *         exclusions (any match → skip), targeting (must be eligible, AND).
 *      c. Assign (cookie-first + deterministic bucket). State lives in the packed
 *         `_testa_exp` cookie — the SAME format the v2 pixel uses, so assignment
 *         is preserved identically across the middleware and the pixel.
 *      d. Emit a `variation_applied` event.
 *      e. If the assigned variation is a redirect, resolve the destination
 *         (variation's match mode) and redirect. First redirect wins.
 *
 * The caller (middleware) MUST only invoke this on a real navigation, never a
 * prefetch — the engine commits cookies via the store and fires listener events.
 */

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
} from '@testa-platform/experiment-core';
import type {
  ExperimentConfig,
  ExperimentRule,
  ProjectConfig,
  VariationConfig,
} from '@testa-platform/shared-types';

/** Payload passed to the `onVariationApplied` listener when a visitor is enrolled. */
export interface VariationAppliedEvent {
  experimentId: number;
  variationId: number;
  /** Experiment title, when set (for the exposure payload / listener). */
  title?: string;
  /** True when the applied variation triggered a server-side redirect. */
  redirected: boolean;
  /** Resolved destination URL, present when `redirected`. */
  destinationUrl?: string;
  visitorId: string;
  /** The request URL the variation was applied on. */
  url: string;
  /** True when freshly bucketed on this request; false when served from the sticky cookie. */
  firstAssignment: boolean;
}

export interface EngineResult {
  /** Destination to 307-redirect to, if an experiment fired. */
  redirectTo?: string;
  /** Every variation applied on this request (control + variant), in order. */
  applied: VariationAppliedEvent[];
}

export interface EngineContext {
  config: ProjectConfig;
  currentUrl: string;
  visitorId: string;
  now: number;
  /** Read a request cookie (for `cookie` targeting). */
  getCookie: (name: string) => string | null;
  userAgent?: string;
  /** ISO country code from a geo header, when available. */
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
    if (!hasRedirectVariation(experiment)) continue;

    // a. Page gate — only enroll on the experiment's page.
    if (!matchesPageRule(ctx.currentUrl, experiment.rules)) continue;

    // b. Entry gates — ONLY for a visitor not yet assigned. Cookie-first wins:
    // a returning enrolled visitor stays in even if their utm/etc. changed.
    if (!hasCachedAssignment(store, experiment.experiment_id)) {
      if (isExcludedByRules(experiment.exclusions, targetingCtx)) continue;
      if (!passesTargeting(experiment.targeting, targetingCtx)) continue;
    }

    // c. Assign (packed `_testa_exp` — same format as the v2 pixel).
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

function hasRedirectVariation(experiment: ExperimentConfig): boolean {
  return experiment.variations.some((v) => redirectChangeOf(v) !== undefined);
}

function redirectChangeOf(variation: VariationConfig): RedirectChange | undefined {
  return variation.changes.find((c): c is RedirectChange => c.type === 'redirect');
}
