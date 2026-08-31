/**
 * Builds a servable `ProjectConfig` (the "testa config") from the upstream
 * project JSON (crobot's `ProjectResource` shape) the config API receives.
 *
 * This is config-BUILDING and lives in the collector because the collector IS
 * the config-building service / single source of truth. It depends ONLY on
 * shared-types — NOT on experiment-core (the decision core), which the collector
 * does not use. Maps both split_url (redirect) and copy (HTML/DOM) experiments;
 *
 * The redirect is assembled from three source places: from_url = experiment url,
 * to_url = the variant variation's single change content, url_match_type = the
 * change's (or variation's) match type. Control is identifier === 0.
 */

import type {
  ExperimentConfig,
  GoalConfig,
  GoalType,
  MatchType,
  ProjectConfig,
  TargetingCondition,
  VariationChange,
  VariationConfig,
} from '@testa-platform/shared-types';

type RedirectMode = NonNullable<Extract<VariationChange, { type: 'redirect' }>['url_match_type']>;

// ─── upstream project-JSON shapes (crobot ProjectResource) ──────────────────

interface SourceChange {
  url_match_type?: string | null;
  content?: string | null;
  selector?: string | null;
  type?: string;
}

interface SourceVariation {
  id?: number;
  identifier: number;
  traffic: number;
  url_match_type?: string | null;
  changes?: SourceChange[];
}

interface SourceRule {
  type: string; // dimension, e.g. utm_source / device / url
  value?: string;
  operator?: string;
}

/** crobot `GoalResource`: { id, title, type, action, match_type, rank }. */
interface SourceGoal {
  id?: number;
  title?: string | null;
  type?: string;
  action?: string | null;
  match_type?: string | null;
}

interface SourceExperiment {
  id?: number;
  identifier: number;
  title?: string;
  url: string;
  url_match_type: string;
  /**
   * Delivery mode for a split_url experiment: `'rewrite'` serves the variant
   * route's content at the control URL (server-side only, zero flicker);
   * anything else — including absent — is the default 307 redirect.
   */
  nav?: string | null;
  traffic: number;
  type: string;
  status: string;
  cross_domain?: number | boolean;
  targeting?: SourceRule[];
  exclusions?: SourceRule[];
  variations?: SourceVariation[];
  goals?: SourceGoal[];
}

const OPERATORS = new Set<TargetingCondition['operator']>([
  'exact',
  'equals',
  'contains',
  'not_contains',
  'regex',
  'not_equals',
]);

/** The upstream project JSON the config API receives and builds from. */
export interface TestaConfigSource {
  id: number;
  name?: string;
  experiments: SourceExperiment[];
}

export interface TestaConfigOptions {
  /** Slug/project_id to stamp; defaults to the source project id. */
  slug?: string;
  integrationVersion?: ProjectConfig['integration_version'];
  consentMode?: ProjectConfig['consent_mode'];
  /** ISO timestamp for `published_at`; defaults to ''. */
  publishedAt?: string;
}

const REDIRECT_MODES = new Set<RedirectMode>(['exact', 'contains', 'query', 'regex']);

/** Build a servable ProjectConfig from the upstream project JSON (split_url + copy experiments). */
export function buildTestaConfig(
  source: TestaConfigSource,
  opts: TestaConfigOptions = {},
): ProjectConfig {
  const experiments = (source.experiments ?? [])
    .filter((e) => e.type === 'split_url' || e.type === 'copy')
    .map(buildExperiment);

  return {
    project_id: source.id,
    slug: opts.slug ?? String(source.id),
    integration_version: opts.integrationVersion ?? '4.0',
    consent_mode: opts.consentMode ?? 'aware',
    experiments,
    published_at: opts.publishedAt ?? '',
    config_hash: hash(JSON.stringify(source.experiments ?? [])),
  };
}

function buildExperiment(e: SourceExperiment): ExperimentConfig {
  const targeting = mapConditions(e.targeting);
  const exclusions = mapConditions(e.exclusions);
  return {
    experiment_id: e.identifier,
    ...(e.title ? { title: e.title } : {}),
    status: mapStatus(e.status),
    traffic_allocation: e.traffic,
    rules: [{ match_type: mapRuleMatchType(e.url_match_type), url_pattern: e.url }],
    goals: mapGoals(e.goals),
    variations: (e.variations ?? []).map((v) => buildVariation(v, e)),
    ...(e.cross_domain ? { cross_domain: true } : {}),
    ...(targeting.length > 0 ? { targeting } : {}),
    ...(exclusions.length > 0 ? { exclusions } : {}),
  };
}

const GOAL_TYPES = new Set<GoalType>(['click', 'page_view', 'custom']);
const GOAL_MATCH_TYPES = new Set<MatchType>(['exact', 'contains', 'not_contains', 'regex']);

/**
 * crobot GoalResource → GoalConfig. Goals with an unknown type or without an
 * id/action can't fire (or can't be attributed by `/api/leads/convert`), so
 * they are dropped rather than served broken. `match_type` only matters for
 * `page_view`; an unrecognised value (e.g. `site_wide`) falls back to
 * `contains` — the 3.3.3 `urlMatches` default.
 */
function mapGoals(goals: SourceGoal[] | undefined): GoalConfig[] {
  return (goals ?? [])
    .filter(
      (g): g is SourceGoal & { id: number; type: GoalType; action: string } =>
        typeof g.id === 'number' &&
        GOAL_TYPES.has(g.type as GoalType) &&
        typeof g.action === 'string' &&
        g.action.length > 0,
    )
    .map((g) => ({
      goal_id: g.id,
      ...(g.title ? { name: g.title } : {}),
      type: g.type,
      action: g.action,
      ...(g.match_type
        ? {
            match_type: GOAL_MATCH_TYPES.has(g.match_type as MatchType)
              ? (g.match_type as MatchType)
              : 'contains',
          }
        : {}),
    }));
}

function mapConditions(rules: SourceRule[] | undefined): TargetingCondition[] {
  return (rules ?? [])
    .filter((r) => typeof r.type === 'string' && r.type.length > 0)
    .map((r) => ({
      dimension: r.type,
      operator: OPERATORS.has(r.operator as TargetingCondition['operator'])
        ? (r.operator as TargetingCondition['operator'])
        : 'contains',
      value: r.value ?? '',
    }));
}

function buildVariation(v: SourceVariation, e: SourceExperiment): VariationConfig {
  // Control (identifier 0) never carries changes.
  if (v.identifier <= 0) return { variation_id: v.identifier, weight: v.traffic, changes: [] };

  const changes: VariationChange[] =
    e.type === 'split_url'
      ? buildRedirectChange(v, e) // split-URL: variant's single change content = destination URL
      : (v.changes ?? []) // `copy`: crobot-native DOM changes, near pass-through
          .map(mapDomChange)
          .filter((c): c is VariationChange => c !== null);

  return { variation_id: v.identifier, weight: v.traffic, changes };
}

/**
 * Split-URL variant → a single `redirect` change.
 *
 * `nav` rides along when the experiment asked to be delivered as a rewrite. It
 * is only emitted for `'rewrite'`: leaving the field off for the default keeps
 * every existing config byte-identical (and so keeps `config_hash` stable for
 * projects that never opt in).
 */
function buildRedirectChange(v: SourceVariation, e: SourceExperiment): VariationChange[] {
  const change = v.changes?.[0];
  if (!change?.content) return [];
  const rewrite = e.nav === 'rewrite';
  return [
    {
      type: 'redirect',
      from_url: e.url,
      to_url: change.content,
      url_match_type: mapRedirectMode(
        change.url_match_type ?? v.url_match_type ?? e.url_match_type,
      ),
      ...(rewrite ? { nav: 'rewrite' as const } : {}),
    },
  ];
}

/**
 * Map one crobot DOM change (`{ type, selector, content }`) to a servable
 * `VariationChange`. crobot's change vocabulary is already the runtime's
 * (`@testa-soft/dom`), so this is a near pass-through. Unknown/empty changes are
 * skipped (returns null).
 */
function mapDomChange(c: SourceChange): VariationChange | null {
  const selector = c.selector ?? '';
  const content = c.content ?? '';
  switch (c.type) {
    case 'change_html':
      return content ? { type: 'change_html', selector, content } : null;
    case 'css':
      return content ? { type: 'css', content } : null;
    case 'hide_element':
      return selector ? { type: 'hide_element', selector } : null;
    case 'append_html':
      return selector && content ? { type: 'append_html', selector, content } : null;
    case 'prepend_html':
      return selector && content ? { type: 'prepend_html', selector, content } : null;
    case 'move_element_append':
      return selector && content ? { type: 'move_element_append', selector, content } : null;
    case 'move_element_prepend':
      return selector && content ? { type: 'move_element_prepend', selector, content } : null;
    default:
      return null;
  }
}

// The upstream has no `paused`; `inactive` is the paused state (sets `paused_at`).
function mapStatus(status: string): ExperimentConfig['status'] {
  switch (status) {
    case 'active':
      return 'active';
    case 'archived':
      return 'archived';
    default:
      return 'paused';
  }
}

// Upstream URLMatchType → our redirect url_match_type. `site_wide` → `contains`;
// anything unknown → `exact`.
function mapRedirectMode(crb: string): RedirectMode {
  if (crb === 'site_wide') return 'contains';
  return REDIRECT_MODES.has(crb as RedirectMode) ? (crb as RedirectMode) : 'exact';
}

// Upstream URLMatchType → our page-rule MatchType (exact|contains|not_contains|regex).
function mapRuleMatchType(crb: string): MatchType {
  switch (crb) {
    case 'contains':
    case 'site_wide':
    case 'query':
      return 'contains';
    case 'regex':
      return 'regex';
    default:
      return 'exact';
  }
}

/** Tiny deterministic string hash (djb2) for `config_hash`. Edge-safe. */
function hash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = (h * 33) ^ input.charCodeAt(i);
  }
  return (h >>> 0).toString(16);
}
