/**
 * PRD-006 tracking from the SDKs (task 5.7): `track` + typed helpers that post
 * pixel-format events to the edge `/track`, stamped with the visitor's active
 * v2 experiment sessions (`exp`) from the packed `_testa_exp` cookie — the same
 * session rules as the pixel (`@testa-soft/experiment-core` exp-session).
 *
 * v2 experiments only (R1): a project with no `platform_version: 'v2'`
 * experiment sends nothing from here (v1 keeps the legacy crobot calls).
 * Events other than experiment_view are dropped when no session is active.
 * Never throws into the host app.
 */
import type { ExpSession, PixelEvent, ProjectConfig } from '@testa-platform/shared-types';
import type { Item } from '@testa-platform/shared-types';
import { onVariationApplied } from '@testa-soft/dom';
import {
  ASSIGNMENT_COOKIE,
  ASSIGNMENT_TTL_SEC,
  type CartOptions,
  type CookieStore,
  type ExpState,
  LIFTED_EVENT_KEYS,
  type PaymentInfoOptions,
  type PurchaseOptions,
  type TrackCall,
  UUID_COOKIE,
  activeExpSessions,
  addToCart,
  beginCheckout,
  lead,
  matchesPageRule,
  parsePacked,
  paymentInfo,
  purchase,
  serializePacked,
  shippingInfo,
  signUp,
  slideExpSession,
  startExpSessionIfNeeded,
} from '@testa-soft/experiment-core';

export const SDK_TRACKER_VERSION = 'sdk-prd006';
/** Same-origin edge route, like the pixel's default. */
export const DEFAULT_EVENTS_ENDPOINT = '/track';
const SESSION_ID_COOKIE = '_testa_sid';
const SESSION_ID_TTL_SEC = 30 * 60;
const SESSIONLESS = new Set(['experiment_view']);

interface Tracker {
  projectId: number;
  endpoint: string;
  store: CookieStore;
  v2: Set<number>;
  send: (events: PixelEvent[]) => void;
}

let _tracker: Tracker | null = null;

const nowSec = (): number => Math.floor(Date.now() / 1000);

function v2Ids(config: ProjectConfig): Set<number> {
  return new Set(
    config.experiments
      .filter((e) => e.status === 'active' && e.platform_version === 'v2')
      .map((e) => e.experiment_id),
  );
}

function defaultSend(endpoint: string): (events: PixelEvent[]) => void {
  return (events) => {
    if (typeof fetch !== 'function') return;
    void fetch(endpoint, {
      method: 'POST',
      keepalive: true,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(events),
    }).catch(() => undefined);
  };
}

function uuidv4(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
    return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** UUIDv7 (time-ordered) event id, as the pixel mints them. */
function uuidv7(ms: number): string {
  const hex = ms.toString(16).padStart(12, '0');
  const rand = uuidv4().replace(/-/g, '');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${rand.slice(13, 16)}-${rand.slice(16, 20)}-${rand.slice(20, 32)}`;
}

function sessionId(store: CookieStore): string {
  const existing = store.get(SESSION_ID_COOKIE);
  const id = existing || uuidv4();
  store.set(SESSION_ID_COOKIE, id, { maxAgeSec: SESSION_ID_TTL_SEC });
  return id;
}

function readMap(store: CookieStore): Map<number, ExpState> {
  return parsePacked(store.get(ASSIGNMENT_COOKIE));
}

function writeMap(store: CookieStore, map: Map<number, ExpState>): void {
  store.set(ASSIGNMENT_COOKIE, serializePacked(map), { maxAgeSec: ASSIGNMENT_TTL_SEC });
}

/** Re-init (PRD §6.1): a new session for every assigned v2 experiment whose session ended. */
export function ensureV2Sessions(
  store: CookieStore,
  ids: Iterable<number>,
  at = nowSec(),
): number[] {
  const map = readMap(store);
  const started: number[] = [];
  for (const id of ids) {
    const next = startExpSessionIfNeeded(map.get(id), at);
    if (next) {
      map.set(id, next);
      started.push(id);
    }
  }
  if (started.length > 0) writeMap(store, map);
  return started;
}

function buildEvent(
  t: Tracker,
  name: string,
  props: Record<string, unknown>,
  exp: ExpSession[],
  ts: number,
): PixelEvent {
  const lifted: Record<string, unknown> = {};
  const rest: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined) continue;
    if (
      (LIFTED_EVENT_KEYS as readonly string[]).includes(k) ||
      k === 'experiment_id' ||
      k === 'variation_id'
    ) {
      lifted[k] = v;
    } else if (
      v === null ||
      typeof v === 'string' ||
      typeof v === 'number' ||
      typeof v === 'boolean'
    ) {
      rest[k] = v;
    } else {
      rest[k] = JSON.stringify(v);
    }
  }
  const hasWindow = typeof window !== 'undefined';
  return {
    event_id: uuidv7(ts),
    event_name: name,
    client_ts: ts,
    project_id: t.projectId,
    visitor_id: t.store.get(UUID_COOKIE) ?? '',
    session_id: sessionId(t.store),
    url: hasWindow ? window.location.href : '',
    ...(typeof document !== 'undefined' && document.referrer
      ? { referrer: document.referrer }
      : {}),
    consent_state: 'unknown',
    tracker_version: SDK_TRACKER_VERSION,
    viewport_w: hasWindow ? window.innerWidth || 0 : 0,
    viewport_h: hasWindow ? window.innerHeight || 0 : 0,
    screen_w: typeof screen !== 'undefined' ? screen.width || 0 : 0,
    screen_h: typeof screen !== 'undefined' ? screen.height || 0 : 0,
    exp,
    in_experiment: exp.length > 0 ? 1 : 0,
    ...(lifted as Partial<PixelEvent>),
    ...(Object.keys(rest).length > 0 ? { props: rest } : {}),
  } as PixelEvent;
}

/**
 * Send one PRD-006 event. No-op until `startPrd006Tracking` ran for a project
 * with v2 experiments; dropped (except experiment_view) with no active session.
 */
export function track(name: string, props: Record<string, unknown> = {}): void {
  const t = _tracker;
  if (!t || t.v2.size === 0) return;
  try {
    const ts = Date.now();
    const sec = Math.floor(ts / 1000);
    const map = readMap(t.store);
    const exp = activeExpSessions((id) => map.get(id), t.v2, sec);
    if (exp.length === 0 && !SESSIONLESS.has(name)) return;
    // Slide every active session (the event is activity), then send.
    for (const [id] of exp) {
      const s = map.get(id);
      if (s) map.set(id, slideExpSession(s, sec));
    }
    if (exp.length > 0) writeMap(t.store, map);
    t.send([buildEvent(t, name, props, exp, ts)]);
  } catch {
    // Tracking must never break the host app.
  }
}

const run = (build: () => TrackCall): void => {
  try {
    const [name, props] = build();
    track(name, props);
  } catch {
    // invalid helper input (e.g. paymentInfo without payment_type): dropped
  }
};

export const trackAddToCart = (items: Item[], opts: CartOptions): void =>
  run(() => addToCart(items, opts));
export const trackBeginCheckout = (items: Item[], opts: CartOptions): void =>
  run(() => beginCheckout(items, opts));
export const trackShippingInfo = (opts: { cart_id?: string } = {}): void =>
  run(() => shippingInfo(opts));
export const trackPaymentInfo = (opts: PaymentInfoOptions): void => run(() => paymentInfo(opts));
export const trackPurchase = (opts: PurchaseOptions): void => run(() => purchase(opts));
export const trackLead = (opts: { lead_type?: string; form_id?: string } = {}): void =>
  run(() => lead(opts));
export const trackSignUp = (opts: { method?: string } = {}): void => run(() => signUp(opts));

export interface Prd006TrackingOptions {
  config: ProjectConfig;
  store: CookieStore;
  /** Edge `/track` URL. Default same-origin `/track`. */
  endpoint?: string;
  /** Transport override (tests). */
  send?: (events: PixelEvent[]) => void;
}

/**
 * Wire PRD-006 tracking for a page / route: re-init sessions for every
 * assigned v2 experiment (any page, §6.1), then fire `experiment_view` through
 * `track` whenever a v2 variation is applied. Returns a teardown.
 */
export function startPrd006Tracking(opts: Prd006TrackingOptions): () => void {
  const v2 = v2Ids(opts.config);
  const endpoint = opts.endpoint ?? DEFAULT_EVENTS_ENDPOINT;
  _tracker = {
    projectId: opts.config.project_id,
    endpoint,
    store: opts.store,
    v2,
    send: opts.send ?? defaultSend(endpoint),
  };
  if (v2.size === 0) return () => undefined;
  try {
    ensureV2Sessions(opts.store, v2);
  } catch {
    // storage blocked: events will simply be sessionless
  }
  const rulesOf = new Map(opts.config.experiments.map((e) => [e.experiment_id, e.rules ?? []]));
  return onVariationApplied((e) => {
    if (!v2.has(e.experiment)) return;
    // The bus replays past events to new subscribers (one per route): only
    // count a view on a page the experiment actually runs on.
    const url = typeof window !== 'undefined' ? window.location.href : '';
    if (!matchesPageRule(url, rulesOf.get(e.experiment) ?? [])) return;
    try {
      ensureV2Sessions(opts.store, [e.experiment]);
    } catch {
      // ignore
    }
    track('experiment_view', { experiment_id: e.experiment, variation_id: e.variation });
  });
}

export function __resetTrackingForTests(): void {
  _tracker = null;
}
