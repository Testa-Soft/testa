/**
 * Shape of the JSON config crobot publishes to CF KV per project.
 * Edge worker reads this on `GET /projects/:slug.js` and inlines it into the
 * served pixel runtime as `window.cfPrefill.project`.
 */

import type { AudienceCondition } from './audience.ts';

export type IntegrationVersion = '3.4' | '3.6' | '4.0';

export type ConsentMode = 'aware' | 'strict';

export type GoalType = 'click' | 'page_view' | 'custom';

export type MatchType = 'exact' | 'contains' | 'not_contains' | 'regex';

export interface ProjectConfig {
  project_id: number;
  slug: string;
  integration_version: IntegrationVersion;
  consent_mode: ConsentMode;
  /** Optional first-party tracking domain (CNAME); when set, edge serves cookies as Domain=.{customer-domain}. */
  tracking_domain?: string;
  experiments: ExperimentConfig[];
  /** ISO timestamp of the last config publish; used as cache-buster for the served bundle. */
  published_at: string;
  /** Content hash of the experiments array; included in the served JS URL for cache invalidation. */
  config_hash: string;
}

export interface ExperimentConfig {
  experiment_id: number;
  /** Human-readable name (3.3.3 `e.title`); surfaced in the GTM dataLayer push. */
  title?: string;
  status: 'active' | 'paused' | 'archived';
  rules: ExperimentRule[];
  variations: VariationConfig[];
  goals: GoalConfig[];
  /** 0..100 share of eligible visitors who participate. Remaining are excluded. */
  traffic_allocation: number;
  /** Optional audience targeting tree (Tier 1+2 dimensions). 4.0 only. */
  audience?: AudienceCondition;
  /** Optional per-experiment frequency cap. 4.0 only. */
  frequency_cap?: { max: number; window: 'session' | 'day' | 'week' | 'month' };
  /** Optional mutex-group name. Visitor in ≤1 active experiment per group. 4.0 only. */
  mutex_group?: string;
  /**
   * When true, the assignment is carried across domains: outbound links to
   * other domains are tagged with `?_testa_cd=<encoded>` and the destination
   * site's pixel applies the assignment without re-rolling traffic. Ported
   * from 3.3.3 `exp.cross_domain`. See `runtime/experiments/cross-domain.ts`.
   */
  cross_domain?: boolean;
  /**
   * Split-URL targeting conditions (crobot `experiment_rules` type
   * `targeting`). ALL must match for the visitor to be eligible (AND). Flat
   * list, distinct from the 4.0 `audience` tree. See `runtime` targeting eval.
   */
  targeting?: TargetingCondition[];
  /**
   * Split-URL exclusion conditions (crobot `experiment_rules` type
   * `exclusion`). If ANY matches, the visitor is excluded (OR).
   */
  exclusions?: TargetingCondition[];
}

/** A single flat targeting/exclusion condition (split-URL). */
export interface TargetingCondition {
  /**
   * Dimension key: `utm_source` | `utm_medium` | `utm_campaign` | `utm_term` |
   * `utm_content` | `utm_keyword` | `url` | `cookie` | `device` |
   * `region_country`. The utm dimensions, url and cookie are derivable
   * server-side; device is UA-derived; region_country needs a geo signal.
   */
  dimension: string;
  operator: 'exact' | 'equals' | 'contains' | 'not_contains' | 'regex' | 'not_equals';
  value: string;
}

export interface ExperimentRule {
  match_type: MatchType;
  url_pattern: string;
}

export interface VariationConfig {
  variation_id: number;
  /** Human-readable name (3.3.3 `VariationName`); surfaced in the GTM dataLayer push. */
  name?: string;
  weight: number;
  /** Visual/code changes the runtime applies for this variation; opaque to the type system. */
  changes: VariationChange[];
}

/**
 * A variation's changes, in crobot's native shape — a flat `{ type, selector?,
 * content? }` per change, using crobot's own change-type names. The runtime
 * (`@testa-platform/dom`) consumes these verbatim, so there's NO lossy adapter
 * between the crobot authoring model and what the browser applies.
 *
 * The split-URL `redirect` variant is the one exception: crobot's `url` change
 * carries only the destination (`content`), so the collector derives `from_url`
 * from the experiment's page URL and emits this engine-facing shape.
 */
export type VariationChange =
  // ── crobot DOM changes (applied by @testa-platform/dom) ──────────────────
  /** crobot `change_html` — set matched elements' innerHTML to `content`. */
  | { type: 'change_html'; selector: string; content: string }
  /** crobot `css` — inject `content` verbatim as a stylesheet (`<style>`). */
  | { type: 'css'; content: string; global?: boolean }
  /** crobot `hide_element` — `display:none` on matched elements. */
  | { type: 'hide_element'; selector: string }
  /** crobot `append_html` — `insertAdjacentHTML('beforeend', content)`. */
  | { type: 'append_html'; selector: string; content: string }
  /** crobot `prepend_html` — `insertAdjacentHTML('afterbegin', content)`. */
  | { type: 'prepend_html'; selector: string; content: string }
  /** crobot `move_element_append` — move matched els under target selector `content` (append). */
  | { type: 'move_element_append'; selector: string; content: string }
  /** crobot `move_element_prepend` — move matched els under target selector `content` (prepend). */
  | { type: 'move_element_prepend'; selector: string; content: string }
  // ── split-URL redirect (crobot `url`; `from_url` derived from the page rule) ──
  | {
      type: 'redirect';
      from_url: string;
      to_url: string;
      /**
       * How `to_url` is derived from the current URL (3.3.3 `createRedirectUrl`):
       * - `exact` (default): navigate to `to_url`, merging current query params.
       * - `contains`: string-replace `from_url` → `to_url` inside the current href.
       * - `query`: keep current URL, set query params parsed from `to_url`.
       * - `regex`: treat `from_url` as a regex; expand `$1..$n` backrefs into `to_url`.
       */
      url_match_type?: 'exact' | 'contains' | 'query' | 'regex';
    };

export interface GoalConfig {
  goal_id: number;
  /** Human-readable name (3.3.3 `goal.name`); surfaced in the GTM conversion push. */
  name?: string;
  type: GoalType;
  /** For `page_view` goals: how `action` (a URL pattern) is matched against the current URL. */
  match_type?: MatchType;
  /**
   * Goal target, semantics per `type`:
   * - `click`   → CSS selector to attach a click listener to.
   * - `page_view` → URL pattern matched via `match_type`.
   * - `custom`  → the custom event name that triggers this goal.
   */
  action: string;
}
