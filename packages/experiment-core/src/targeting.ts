/**
 * Split-URL targeting + exclusion evaluation.
 *
 *   - targeting: ALL conditions must be satisfied (AND) for the visitor to be
 *     eligible for the experiment.
 *   - exclusions: if ANY condition matches (OR), the visitor is excluded.
 *
 * Dimensions the middleware can evaluate server-side:
 *   - url            → the full request URL
 *   - cookie         → a request cookie (value `name=val` or just `name`)
 *   - device         → UA-derived (mobile | tablet | desktop)
 *   - region_country → a geo signal (ISO country) if the host provides one
 *   - experiment     → visitor is ASSIGNED (variation ≥ 0) to experiment
 *     `value` — crobot's cross-experiment (mutual) exclusion. Parses the packed
 *     cookie FRESH via `getCookie`, so an assignment made earlier in the same
 *     request (read-through store) already counts: the per-visitor shuffled
 *     order (order.ts) = priority.
 *   - anything else  → a URL query param looked up by the dimension name
 *     (utm_source, gclid, …) — 3.3.3's `handleURLParameter` default case.
 *
 * Fail policy for a dimension we CAN'T evaluate (e.g. geo with no signal):
 *   - targeting  → treat as NOT satisfied (don't run an experiment we can't
 *     confirm the visitor qualifies for).
 *   - exclusion  → treat as NOT matching (don't over-exclude on unverifiable data).
 */

import type { TargetingCondition } from '@testa-platform/shared-types';
import { ASSIGNMENT_COOKIE } from './cookie-store.ts';
import { parsePacked } from './packed-cookie.ts';
import { safeUrl } from './redirect/url.ts';
import { isUrlTracing, traceUrl } from './trace.ts';

export interface TargetingContext {
  url: string;
  getCookie: (name: string) => string | null;
  userAgent?: string;
  /** ISO country code (e.g. "US"), when the host provides a geo signal. */
  country?: string;
}

interface Resolved {
  supported: boolean;
  value: string | null;
}

function resolveDimension(dimension: string, ctx: TargetingContext): Resolved {
  if (dimension === 'url') {
    return { supported: true, value: ctx.url };
  }
  if (dimension === 'device') {
    if (!ctx.userAgent) return { supported: false, value: null };
    return { supported: true, value: deviceOf(ctx.userAgent) };
  }
  if (dimension === 'region_country') {
    if (!ctx.country) return { supported: false, value: null };
    return { supported: true, value: ctx.country };
  }
  if (dimension === 'cookie') {
    // handled specially in matchCookie; not resolved to a single value here
    return { supported: true, value: null };
  }
  // Any other dimension is a URL query parameter looked up BY NAME (utm_source,
  // utm_medium, gclid, …) — 3.3.3 `handleURLParameter` is the `default:` case
  // of its rule switch, so every unrecognized rule type resolves this way.
  const u = safeUrl(ctx.url);
  return { supported: true, value: u ? u.searchParams.get(dimension) : null };
}

function deviceOf(ua: string): string {
  if (/iPad|Tablet/i.test(ua)) return 'tablet';
  if (/Mobi|Android|iPhone|iPod/i.test(ua)) return 'mobile';
  return 'desktop';
}

function applyOperator(
  operator: TargetingCondition['operator'],
  actual: string | null,
  value: string,
): boolean {
  switch (operator) {
    case 'exact':
    case 'equals':
      return actual === value;
    case 'not_equals':
      return actual !== value;
    case 'contains':
      return actual !== null && actual.includes(value);
    case 'not_contains':
      return actual === null || !actual.includes(value);
    case 'regex':
      if (actual === null) return false;
      try {
        return new RegExp(value).test(actual);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

/**
 * A `cookie` condition's value is `name=expected` (match value) or just `name`
 * (presence). Evaluated against the request cookies.
 */
function matchCookie(condition: TargetingCondition, ctx: TargetingContext): boolean {
  const [name, ...rest] = condition.value.split('=');
  if (!name) return false;
  const actual = ctx.getCookie(name);
  const expected = rest.join('=');
  if (expected === '') {
    // presence check
    return condition.operator === 'not_equals' || condition.operator === 'not_contains'
      ? actual === null
      : actual !== null;
  }
  return applyOperator(condition.operator, actual, expected);
}

/** Does a single condition match? `unsupported` reports whether we could evaluate it. */
function evaluate(
  condition: TargetingCondition,
  ctx: TargetingContext,
): { matched: boolean; supported: boolean } {
  if (condition.dimension === 'cookie') {
    return { matched: matchCookie(condition, ctx), supported: true };
  }
  if (condition.dimension === 'experiment') {
    return matchExperiment(condition, ctx);
  }
  const { supported, value } = resolveDimension(condition.dimension, ctx);
  if (!supported) return { matched: false, supported: false };
  return { matched: applyOperator(condition.operator, value, condition.value), supported: true };
}

/**
 * True when the visitor is eligible. Mirrors crobot 3.3.3 `shouldTarget`:
 * conditions are grouped by dimension, **OR within a group** (any rule of that
 * dimension may pass), **AND across groups** (every dimension must pass). An
 * unsupported/unmatched condition just doesn't count toward its group's OR; a
 * group with no passing rule fails the whole check.
 */
export function passesTargeting(
  targeting: TargetingCondition[] | undefined,
  ctx: TargetingContext,
): boolean {
  if (!targeting || targeting.length === 0) return true;

  const groups = new Map<string, TargetingCondition[]>();
  for (const c of targeting) {
    const g = groups.get(c.dimension);
    if (g) g.push(c);
    else groups.set(c.dimension, [c]);
  }

  for (const conditions of groups.values()) {
    const anyPass = conditions.some((c) => {
      const { matched, supported } = evaluate(c, ctx);
      return supported && matched;
    });
    if (!anyPass) return false;
  }
  return true;
}

/**
 * `dimension: 'experiment'` — is the visitor ASSIGNED to experiment `value`?
 * Assignment means a real variation (≥ 0, control included); parked eligibility
 * (-2) and cached exclusions do not count. Parsed fresh from the packed cookie
 * on every evaluation so same-request assignments are visible (read-through
 * store) and the operator keeps working as URL params come and go.
 */
function matchExperiment(
  condition: TargetingCondition,
  ctx: TargetingContext,
): { matched: boolean; supported: boolean } {
  // Only equality makes sense for "in experiment N"; anything else is treated
  // as unsupported (targeting → not satisfied, exclusion → not excluding).
  if (condition.operator !== 'equals') return { matched: false, supported: false };
  const id = Number(condition.value);
  if (!Number.isFinite(id)) return { matched: false, supported: false };
  const state = parsePacked(ctx.getCookie(ASSIGNMENT_COOKIE)).get(id);
  return {
    matched: state !== undefined && !state.excluded && state.variation >= 0,
    supported: true,
  };
}

/** True when the visitor is excluded (ANY exclusion matches). Unsupported → not excluding. */
export function isExcludedByRules(
  exclusions: TargetingCondition[] | undefined,
  ctx: TargetingContext,
): boolean {
  if (!exclusions || exclusions.length === 0) return false;

  let hit: TargetingCondition | undefined;
  // `some` short-circuits, which is what we want in production; the tracing
  // branch evaluates every rule so a trace shows the full picture rather than
  // stopping at the first match.
  const excluded = isUrlTracing()
    ? exclusions.reduce((acc, c) => {
        const { matched, supported } = evaluate(c, ctx);
        if (supported && matched && !hit) hit = c;
        return acc || (supported && matched);
      }, false)
    : exclusions.some((c) => {
        const { matched, supported } = evaluate(c, ctx);
        return supported && matched;
      });

  traceUrl({
    stage: 'exclusion',
    in: ctx.url,
    detail: {
      excluded,
      ...(hit ? { matchedBy: `${hit.dimension} ${hit.operator} ${hit.value}` } : {}),
      // Which rules COULD have matched had the URL carried what they look for —
      // the fast way to see that a rule is inert because the value never arrives.
      ...(excluded ? {} : { evaluated: exclusions.length }),
    },
  });
  return excluded;
}
