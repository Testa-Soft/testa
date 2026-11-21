/**
 * Targeting + exclusion evaluation (all experiment types).
 *
 * Two list shapes:
 *   - FLAT (no condition carries `group`; v1 and ungrouped v2) — crobot 3.3.3:
 *       targeting  → conditions bucketed by dimension, OR within a dimension,
 *                    AND across dimensions.
 *       exclusions → excluded if ANY condition matches.
 *   - GROUPED (v2 rule groups) — passes / fires when EVERY condition of at
 *     least one group matches; an ungrouped condition is a group of its own.
 *     Served under `targeting_groups` / `exclusion_groups`; read the lists via
 *     {@link targetingOf} / {@link exclusionsOf}, which prefer those keys over
 *     the legacy fields (which then only hold fail-closed sentinels for older
 *     SDKs).
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

import type { ExperimentConfig, TargetingCondition } from '@testa-platform/shared-types';
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

/**
 * The experiment's effective targeting list: `targeting_groups` when the
 * experiment uses v2 rule groups (the legacy `targeting` then only holds the
 * sentinel that keeps older SDKs out), else the flat `targeting`.
 */
export function targetingOf(
  experiment: Pick<ExperimentConfig, 'targeting' | 'targeting_groups'>,
): TargetingCondition[] | undefined {
  return experiment.targeting_groups ?? experiment.targeting;
}

/** The experiment's effective exclusion list — see {@link targetingOf}. */
export function exclusionsOf(
  experiment: Pick<ExperimentConfig, 'exclusions' | 'exclusion_groups'>,
): TargetingCondition[] | undefined {
  return experiment.exclusion_groups ?? experiment.exclusions;
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
  const u = parsedUrl(ctx);
  return { supported: true, value: u ? u.searchParams.get(dimension) : null };
}

// One parse per context (and URL), not one per query-param condition.
const urlCache = new WeakMap<TargetingContext, { url: string; parsed: URL | null }>();

function parsedUrl(ctx: TargetingContext): URL | null {
  const hit = urlCache.get(ctx);
  if (hit && hit.url === ctx.url) return hit.parsed;
  const parsed = safeUrl(ctx.url);
  urlCache.set(ctx, { url: ctx.url, parsed });
  return parsed;
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
      return actual?.includes(value) ?? false;
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
 * True when the visitor is eligible. A FLAT list mirrors crobot 3.3.3
 * `shouldTarget`: conditions are bucketed by dimension, **OR within a
 * dimension** (any rule of it may pass), **AND across dimensions** (every
 * dimension must pass). A GROUPED list (any condition has `group`) passes when
 * every condition of at least one group matches. Either way an unsupported
 * condition doesn't match. Pass {@link targetingOf}(experiment), not the raw
 * `targeting` field.
 */
export function passesTargeting(
  targeting: TargetingCondition[] | undefined,
  ctx: TargetingContext,
): boolean {
  if (!targeting || targeting.length === 0) return true;
  if (isGrouped(targeting)) return firstMatchingGroup(targeting, ctx) !== undefined;

  const groups = new Map<string, TargetingCondition[]>();
  for (const c of targeting) {
    const g = groups.get(c.dimension);
    if (g) g.push(c);
    else groups.set(c.dimension, [c]);
  }

  for (const conditions of groups.values()) {
    if (!conditions.some((c) => matches(c, ctx))) return false;
  }
  return true;
}

/** v2 lists carry `group` on their conditions; v1 lists never do. */
function isGrouped(conditions: TargetingCondition[]): boolean {
  return conditions.some((c) => c.group !== undefined);
}

function matches(condition: TargetingCondition, ctx: TargetingContext): boolean {
  const { matched, supported } = evaluate(condition, ctx);
  return supported && matched;
}

/**
 * v2 rule groups: the first group (in list order) whose conditions ALL match,
 * or undefined. A condition without a group forms its own group. A condition
 * we can't evaluate doesn't match, so it fails its group (the same fail policy
 * as flat).
 */
function firstMatchingGroup(
  conditions: TargetingCondition[],
  ctx: TargetingContext,
): TargetingCondition[] | undefined {
  const groups = new Map<string, TargetingCondition[]>();
  conditions.forEach((c, i) => {
    const key = c.group === undefined ? `solo:${i}` : `g:${c.group}`;
    const group = groups.get(key);
    if (group) group.push(c);
    else groups.set(key, [c]);
  });
  for (const group of groups.values()) {
    if (group.every((c) => matches(c, ctx))) return group;
  }
  return undefined;
}

function describeCondition(c: TargetingCondition): string {
  return `${c.dimension} ${c.operator} ${c.value}`;
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

/**
 * True when the visitor is excluded. FLAT: ANY condition matches. GROUPED:
 * every condition of some group matches. Unsupported → not excluding. Pass
 * {@link exclusionsOf}(experiment), not the raw `exclusions` field.
 */
export function isExcludedByRules(
  exclusions: TargetingCondition[] | undefined,
  ctx: TargetingContext,
): boolean {
  if (!exclusions || exclusions.length === 0) return false;

  if (isGrouped(exclusions)) {
    const group = firstMatchingGroup(exclusions, ctx);
    traceUrl({
      stage: 'exclusion',
      in: ctx.url,
      detail: {
        excluded: group !== undefined,
        grouped: true,
        ...(group ? { matchedBy: group.map(describeCondition).join(' AND ') } : {}),
        ...(group ? {} : { evaluated: exclusions.length }),
      },
    });
    return group !== undefined;
  }

  let hit: TargetingCondition | undefined;
  // `some` short-circuits, which is what we want in production; the tracing
  // branch evaluates every rule so a trace shows the full picture rather than
  // stopping at the first match.
  const excluded = isUrlTracing()
    ? exclusions.reduce((acc, c) => {
        const matched = matches(c, ctx);
        if (matched && !hit) hit = c;
        return acc || matched;
      }, false)
    : exclusions.some((c) => matches(c, ctx));

  traceUrl({
    stage: 'exclusion',
    in: ctx.url,
    detail: {
      excluded,
      ...(hit ? { matchedBy: describeCondition(hit) } : {}),
      // Which rules COULD have matched had the URL carried what they look for —
      // the fast way to see that a rule is inert because the value never arrives.
      ...(excluded ? {} : { evaluated: exclusions.length }),
    },
  });
  return excluded;
}
