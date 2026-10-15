import type { ConsentState } from './consent.ts';

/**
 * Reserved event names with first-class metric support (AOV, RPV, funnel, sessions).
 * Anything else is a generic event keyed by `event_name`. Commerce names follow
 * GA4 verbatim (PRD-006 §1.1–1.2).
 */
export type ReservedEventName =
  | 'page_view'
  | 'session_start'
  | 'experiment_view'
  /** A configured goal fired (3.3.3 parity: click/page_view/custom goal match). Carries `goal_id`. */
  | 'conversion'
  /**
   * Lead/participation signal (3.3.3 `createLead`). Carries `experiment_id`+`variation_id`.
   * ⚠ Not the marketing lead metric: that is GA4's `generate_lead`. The two are unrelated.
   */
  | 'lead_generated'
  | 'purchase'
  | 'add_to_cart'
  | 'begin_checkout'
  /** Contact / shipping details submitted in checkout (GA4). Feeds Contact Details Rate. */
  | 'add_shipping_info'
  /** Payment step reached (GA4). Carries `props.payment_type` and `props.coupon`. */
  | 'add_payment_info'
  /**
   * Lead form submitted (GA4). Feeds Lead / Register Rate.
   * ⚠ Not `lead_generated` (the 3.3.3 participation signal).
   */
  | 'generate_lead'
  | 'sign_up'
  | 'view_item'
  | 'view_item_list'
  | 'remove_from_cart'
  | 'view_cart'
  /** @deprecated Alias of `begin_checkout`; the edge normalizes it (PRD-006 §1.1). */
  | 'checkout_start'
  /** Synthetic — pixel-side delivery health (queued/sent/dropped/retried/oldest_age). */
  | '_pixel_health';

export type EventName = ReservedEventName | (string & { __brand?: 'CustomEvent' });

/**
 * One active experiment session at fire time (PRD-006 §1.3–1.4):
 * `[experiment_id, variation_id, session_start, session_idx]`.
 * `session_start` = Unix seconds the experiment session began (identifies it);
 * `session_idx` = 1 for the visitor's first session in that experiment, 2 for the second…
 */
export type ExpSession = [number, number, number, number];

/** `page_view` hint (PRD-006 §1.4). */
export type PageType =
  | 'home'
  | 'category'
  | 'product'
  | 'search'
  | 'cart'
  | 'checkout'
  | 'thank_you'
  | 'other';

export type PurchaseType = 'initial' | 'upsell';

/** Which ad click id was present on the entry page. Type only, never the value. */
export type ClickIdType =
  | 'gclid'
  | 'gbraid'
  | 'wbraid'
  | 'fbclid'
  | 'msclkid'
  | 'ttclid'
  | 'li_fat_id';

/** GA4 item shape plus an explicit parent `product_id` (PRD-006 §1.6). */
export interface Item {
  /** REQUIRED. SKU / variant-level key. Stable across sessions. */
  item_id: string;
  /** Parent product key (groups variants). Defaults to item_id. */
  product_id?: string;
  item_name?: string;
  item_variant?: string;
  item_brand?: string;
  /** Top level, e.g. "Apparel" (GA4 hierarchy down to item_category5). */
  item_category?: string;
  item_category2?: string;
  item_category3?: string;
  item_category4?: string;
  item_category5?: string;
  /** Unit price after item-level discount, in event currency. */
  price?: number;
  /** Integer ≥ 1, default 1. */
  quantity?: number;
  /** Unit discount amount. */
  discount?: number;
  /** Item-level coupon. */
  coupon?: string;
  /** Which list it was clicked from (P1). */
  item_list_id?: string;
  item_list_name?: string;
  /** Position in that list (P1). */
  index?: number;
}

/**
 * Wire format the pixel posts to the edge worker. Optional fields are omitted
 * when absent (not null) to keep payloads small.
 *
 * `event_id` is a UUIDv7 generated client-side and persisted in the IDB outbox.
 * Same retried event keeps the same UUID; collector dedups by `event_id` for
 * configured event names (default `purchase`).
 */
export interface PixelEvent {
  event_id: string;
  event_name: EventName;
  /** Client clock at fire time, Unix ms. Renamed from `ts` in 2026-05-06 schema extension. */
  client_ts: number;
  project_id: number;
  experiment_id?: number;
  variation_id?: number;
  /** Present on `conversion` events — which configured goal matched. */
  goal_id?: number;
  visitor_id: string;
  session_id: string;
  url: string;
  referrer?: string;
  consent_state: ConsentState;
  /** Build-time pixel version, e.g. `'4.0.3'`. Diagnostic. */
  tracker_version: string;
  /** `window.innerWidth` / `window.innerHeight` at fire time. 0 if unavailable. */
  viewport_w: number;
  viewport_h: number;
  /** `screen.width` / `screen.height` (device resolution). 0 if unavailable. */
  screen_w: number;
  screen_h: number;
  /**
   * Active v2 experiment sessions at fire time (PRD-006 §1.3). The platform
   * attributes an event to experiment E iff E is in here. Required on every
   * event the pixel sends; empty only for `_pixel_health`.
   */
  exp: ExpSession[];
  /**
   * Browser-session count on the site (cookie `_testa_vn`). Informational
   * only; **not** used for new vs returning (PRD-006 §1.3a). Optional per §5.3.
   */
  visit_number?: number;
  /**
   * 1 if the visitor was in an experiment (past their first exposure) when this
   * event fired, else 0. Stamped by the pixel (task 3.16); equals `notEmpty(exp)`.
   * Drives differential ClickHouse retention (page_view: 1d vs 90d).
   */
  in_experiment?: 0 | 1;
  /** UTM params parsed from the current page's `location.search`. Empty string if absent. */
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_term?: string;
  utm_content?: string;
  /**
   * Session-entry attribution (PRD-006 §3.6): captured on the first page of
   * the browsing session, stamped on `experiment_view` only.
   */
  entry_referrer?: string;
  entry_url?: string;
  entry_utm_source?: string;
  entry_utm_medium?: string;
  entry_utm_campaign?: string;
  entry_utm_term?: string;
  entry_utm_content?: string;
  click_id_type?: ClickIdType;
  page_type?: PageType;
  /** Ties add_to_cart → begin_checkout → purchase for the same cart. */
  cart_id?: string;
  /**
   * Item revenue net of discounts, **excluding tax and shipping** (PRD-006 §1.7).
   * Required on `purchase`.
   */
  value_native?: number;
  /** ISO 4217. Required whenever `value_native` is present. */
  currency?: string;
  /** Required on `purchase`. Business dedup key; an upsell carries its own id. */
  order_id?: string;
  /** On `purchase`; absent = `initial`. */
  purchase_type?: PurchaseType;
  /** Required when `purchase_type = 'upsell'`: the initial order's id. */
  parent_order_id?: string;
  /** Sum of item quantities. Derived by the edge from `items` if omitted. */
  items_count?: number;
  /**
   * Required on `add_to_cart`, `begin_checkout`, `purchase`, `view_item`; max 50
   * (the edge truncates and sets `props._items_truncated = 1`).
   */
  items?: Item[];
  /** Generic key/value bag for custom events. Values are stringified at the edge. */
  props?: Record<string, string | number | boolean | null>;
}

/**
 * Enriched format the edge worker forwards to the collector. Adds geo (country,
 * region, region_subdivision, city), UA-derived device fields, bot signal, and
 * `server_ts`. Visitor IP is intentionally NOT included (privacy: truncated or
 * hashed at the edge before forwarding).
 */
export interface EnrichedEvent extends PixelEvent {
  /** Edge-worker reception time, Unix ms. Renamed from `ingested_at`. */
  server_ts: number;
  country: string;
  region: string;
  region_subdivision: string;
  city: string;
  device_type: 'desktop' | 'mobile' | 'tablet' | 'bot' | 'unknown';
  /** Combined `name version`, kept for compatibility. Prefer `browser_name`. */
  browser: string;
  /** Combined `name version`, kept for compatibility. Prefer `os_name`. */
  os: string;
  /** Family, no version: `iOS`, `Android`, `Windows`, `macOS`, `Linux`, `ChromeOS`. */
  os_name: string;
  os_version: string;
  /** `Chrome`, `Safari`, `Firefox`, `Edge`, `Samsung Internet`… */
  browser_name: string;
  browser_version: string;
  /** Host of `entry_referrer`, `www.` stripped; `(direct)` if empty or same-site. */
  referrer_domain: string;
  /** Edge-derived channel grouping (PRD-006 §3.6 rules), e.g. `Paid Search`. */
  channel: string;
  is_bot: 0 | 1;
}

/**
 * Batch envelope HMAC-signed by the edge worker, accepted by collector /_ingest.
 */
export interface IngestBatch {
  events: EnrichedEvent[];
  /** Unix milliseconds when the batch was signed. Used for ±5 min replay window check. */
  signed_at: number;
}
