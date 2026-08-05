/**
 * Split-URL targeting + exclusion evaluation.
 *
 *   - targeting: ALL conditions must be satisfied (AND) for the visitor to be
 *     eligible for the experiment.
 *   - exclusions: if ANY condition matches (OR), the visitor is excluded.
 *
 * Dimensions the middleware can evaluate server-side:
 *   - utm_source/medium/campaign/term/content/keyword → URL query params
 *   - url            → the full request URL
 *   - cookie         → a request cookie (value `name=val` or just `name`)
 *   - device         → UA-derived (mobile | tablet | desktop)
 *   - region_country → a geo signal (ISO country) if the host provides one
 *
 * Fail policy for a dimension we CAN'T evaluate (e.g. geo with no signal):
 *   - targeting  → treat as NOT satisfied (don't run an experiment we can't
 *     confirm the visitor qualifies for).
 *   - exclusion  → treat as NOT matching (don't over-exclude on unverifiable data).
 */

import type { TargetingCondition } from '@testa-platform/shared-types';
import { safeUrl } from './redirect/url.ts';

export interface TargetingContext {
  url: string;
  getCookie: (name: string) => string | null;
  userAgent?: string;
  /** ISO country code (e.g. "US"), when the host provides a geo signal. */
  country?: string;
}

const UTM_DIMENSIONS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_keyword',
]);

interface Resolved {
  supported: boolean;
  value: string | null;
}

function resolveDimension(dimension: string, ctx: TargetingContext): Resolved {
  if (UTM_DIMENSIONS.has(dimension)) {
    const u = safeUrl(ctx.url);
    return { supported: true, value: u ? u.searchParams.get(dimension) : null };
  }
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
  return { supported: false, value: null };
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
  const { supported, value } = resolveDimension(condition.dimension, ctx);
  if (!supported) return { matched: false, supported: false };
  return { matched: applyOperator(condition.operator, value, condition.value), supported: true };
}

/** True when every targeting condition is satisfied (AND). Unsupported → not eligible. */
export function passesTargeting(
  targeting: TargetingCondition[] | undefined,
  ctx: TargetingContext,
): boolean {
  if (!targeting || targeting.length === 0) return true;
  return targeting.every((c) => {
    const { matched, supported } = evaluate(c, ctx);
    return supported && matched;
  });
}

/** True when the visitor is excluded (ANY exclusion matches). Unsupported → not excluding. */
export function isExcludedByRules(
  exclusions: TargetingCondition[] | undefined,
  ctx: TargetingContext,
): boolean {
  if (!exclusions || exclusions.length === 0) return false;
  return exclusions.some((c) => {
    const { matched, supported } = evaluate(c, ctx);
    return supported && matched;
  });
}
