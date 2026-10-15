/**
 * Runtime lifecycle — the composition root that wires together all the
 * modules built in earlier Phase 3 tasks (cookies, consent, audience,
 * traffic) into a single hydration sequence.
 *
 * What this owns:
 *   1. Replace `window._testa` stub method bodies with live implementations.
 *   2. Drain `window._testa.q` (calls customers made before the runtime loaded).
 *   3. Listen for `_testa:locationchange` and re-run the experiment cycle on
 *      SPA route changes (without re-doing one-time init).
 *   4. Run the first experiment-resolution cycle and fire `_testa.load()`.
 *
 * What this does NOT own:
 *   - Storage backend selection (lives in `network/outbox.ts`).
 *   - HTTP retry / sendBeacon flushing (lives in `network/transport.ts`).
 *
 * The in-memory `_pendingEvents` mirror is kept as an inspection / test hook;
 * the durable outbox is the source of truth for what actually leaves the page.
 */

import type {
  AudienceCondition,
  ExpSession,
  ExperimentConfig,
  PixelEvent,
  ProjectConfig,
} from '@testa-platform/shared-types';
import type { ConsentState } from '@testa-platform/shared-types';
import { type Teardown, applyVariation } from '@testa-soft/dom';
import { matchesPageRule, shuffleForVisitor } from '@testa-soft/experiment-core';
import type { TestaDebugSnapshot } from '../loader/queue.ts';
import { TRACKER_VERSION } from '../version.ts';
import { entryFor, readUtms, stripClickIds } from './attribution.ts';
import * as consentMod from './consent.ts';
import * as cookies from './cookies.ts';
import {
  type CrossDomainExperiment,
  applyInboundCrossDomain,
  eligibleCrossDomainExperiments,
  installCrossDomainLinkTagging,
  tagUrl,
} from './experiments/cross-domain.ts';
import {
  type AssignedExperiment,
  type GoalController,
  createGoalController,
} from './experiments/goals.ts';
import * as expSessions from './experiments/session.ts';
import {
  type AssignResult,
  type Experiment,
  assign,
  recordExposure,
} from './experiments/traffic.ts';
import { pushLeadToDataLayer } from './legacy/data-layer.ts';
import { fireEvent, installLegacy, publishLoaded, publishUuid } from './legacy/index.ts';
import { snapshot as healthSnapshot, recordDroppedNoSession } from './network/health.ts';
import { initOutbox, count as outboxCount, enqueue as outboxEnqueue } from './network/outbox.ts';
import { installTransport, notifyEnqueue, shipEventSync } from './network/transport.ts';
import { uuidv7 } from './network/uuid7.ts';
import { maybeEnterPreviewMode } from './preview.ts';
import { readBreadcrumbs as readRedirectBreadcrumbs } from './redirect/breadcrumbs.ts';
import { evaluateAndApply as evaluateRedirect } from './redirect/index.ts';
import { type EvalContext, evaluate } from './rules/audience.ts';
import { SESSION_ID_COOKIE, getOrCreateSessionId, readVisitNumber } from './session.ts';
import { installSpaHandler } from './spa.ts';
import { readValue } from './storage.ts';
import { detectBrowser, detectOs } from './ua.ts';

const LOCATIONCHANGE_EVENT = '_testa:locationchange';

interface PendingEvent {
  name: string;
  props: Record<string, unknown>;
  ts: number;
  /** The wire payload as sent (absent for synthetic debug entries). Test/inspection hook. */
  event?: PixelEvent;
}

interface CfPrefill {
  project?: ProjectConfig;
  apiUrl?: string;
  env?: string;
}

interface PixelDebug {
  cycles: Array<{
    ts: number;
    url: string;
    matchedExperiments: number;
    excludedExperiments: number;
  }>;
  errors: Array<{ ts: number; phase: string; message: string }>;
}

declare global {
  interface Window {
    cfPrefill?: CfPrefill;
    cfGeoData?: { country?: string; region?: string };
    __pixel_debug?: PixelDebug;
  }
}

const MAX_DEBUG_ENTRIES = 50;
let _pendingEvents: PendingEvent[] = [];
let _alreadyHydrated = false;
/** DOM-watching teardowns from the previous cycle's appliers; disposed at the start of each cycle. */
let _activeTeardowns: Teardown[] = [];
/** Goal controller for the current cycle (click listeners + custom-goal registry). */
let _goals: GoalController | null = null;
/** True once preview mode took over — the normal experiment cycle is skipped. */
let _previewActive = false;

/**
 * Top-level entry. Idempotent. Errors anywhere in the pipeline are
 * caught and routed to `_pixel_health` (a synthetic event the network
 * module will pick up on flush, Phase 3.6).
 */
export function hydrate(): void {
  if (_alreadyHydrated) return;
  _alreadyHydrated = true;

  ensurePixelDebug();
  applyConsentMode();

  guardedInit('legacy_globals', () => {
    installLegacy({
      pushEvent: (name, data) => {
        // Customer-fired custom events route through the same `track` pipe
        // as `_testa.track()`, so dashboards see them — AND are matched against
        // any `custom` goals so they can record conversions.
        trackCustomerEvent(name, (data as Record<string, unknown> | undefined) ?? {});
      },
    });
  });
  guardedInit('cmp_listener', () => consentMod.installCmpListener());
  guardedInit('consent_replay', installConsentReplay);
  guardedInit('live_api', installLiveApi);
  guardedInit('spa_listener', installSpaListener);
  guardedInit('network', installNetwork);
  guardedInit('pixel_health', installHealthFlush);
  guardedInit('debug_polls', startPendingCountPoll);

  // First experiment cycle. Drain queue first so any pre-runtime calls
  // (e.g. `_testa.consent('denied')` set BEFORE the loader fired) win
  // before the cycle reads consent state.
  guardedInit('drain_queue', drainQueue);

  // Apply an inbound `_testa_cd` bridge BEFORE the first cycle so assign()'s
  // cookie-first lookup returns the carried variation instead of re-rolling
  // traffic (3.3.3 `applyCrossDomainTracking`, called before `r.process()`).
  guardedInit('cross_domain_inbound', applyInboundBridge);

  // Preview mode short-circuits the normal experiment cycle: fetch + apply the
  // draft changes for the preview session and skip assignment entirely (3.3.3
  // `?testa_preview=true` guard).
  guardedInit('preview_mode', () => {
    _previewActive = maybeEnterPreviewMode({
      apiUrl: window.cfPrefill?.apiUrl,
      apply: (variationId, changes) => {
        _activeTeardowns.push(...applyVariation(variationId, changes));
      },
    });
  });

  if (!_previewActive) {
    guardedInit('first_cycle', () => {
      runExperimentCycle();
    });
    // Tag outbound cross-domain links after the first cycle has resolved
    // assignments (3.3.3 `setupCrossDomainLinkTracking`). The install self-covers
    // SPA navigation via its interval + MutationObserver, so it runs once.
    guardedInit('cross_domain_links', installCrossDomainLinks);
  }

  // Fire load() once. SPA re-evaluations don't re-fire it.
  guardedInit('fire_ready', fireReady);
}

// ─── live API installation ─────────────────────────────────────────────────

function installLiveApi(): void {
  const stub = window._testa;
  if (!stub) return;

  // Replace each queued-by-default method with a live impl. The `_loaded`
  // and `q` properties stay so customers' SmartCode listening for them
  // doesn't break.
  stub.track = (name, props) => {
    trackCustomerEvent(name, props);
  };
  stub.trackPurchase = (value, currency, orderId, items) => {
    trackCustomerEvent('purchase', {
      value_native: value,
      currency,
      order_id: orderId,
      ...(items !== undefined ? { items_count: items } : {}),
    });
  };
  stub.consent = (state) => {
    consentMod.consent.setState(state);
  };
  stub.identify = (visitorId) => {
    // Store in a custom-namespaced cookie that Phase 5/6 picks up to merge
    // with the worker-set _testa_uuid. For now: no-op until that flow lands.
    void visitorId;
  };
  stub.navigate = (url) => {
    // Programmatic SPA navigation hint. We don't change history here —
    // customer / framework code does that. We just dispatch the event so
    // re-eval runs on the new URL even if monkey-patch missed it.
    void url;
    window.dispatchEvent(new CustomEvent(LOCATIONCHANGE_EVENT));
  };
  stub.debug = buildDebugSnapshot;
  stub._hydrated = true;
}

/**
 * Synchronous snapshot for `_testa.debug()`. Pulls from the same in-memory
 * sources the production code uses, so what customer support sees here is
 * what the runtime sees.
 *
 * Pending count is a synchronous best-effort read; the outbox count is
 * async, but we cache the most recent value via a side-channel update.
 */
function buildDebugSnapshot(): TestaDebugSnapshot {
  const debug = window.__pixel_debug ?? { cycles: [], errors: [] };
  const health = healthSnapshot(0);
  return {
    hydrated: true,
    tracker_version: TRACKER_VERSION,
    consent_state: consentMod.consent.getState(),
    consent_strict: consentMod.consent.isHeld() || readProject()?.consent_mode === 'strict',
    visitor_id: cookies.getUuid(),
    session_id: _lastSessionId,
    url: typeof location !== 'undefined' ? location.href : '',
    cycles: debug.cycles ?? [],
    errors: debug.errors ?? [],
    redirects: readRedirectBreadcrumbs().map((b) => ({
      ts: b.ts,
      phase: b.phase,
      experiment_id: b.experiment_id,
      ...(b.from !== undefined ? { from: b.from } : {}),
      ...(b.to !== undefined ? { to: b.to } : {}),
    })),
    network: {
      queued: health.queued ?? 0,
      sent: health.sent ?? 0,
      dropped: health.dropped ?? 0,
      retried: health.retried ?? 0,
      pending: _lastPendingCount,
    },
  };
}

let _lastSessionId: string | null = null;
let _lastPendingCount = 0;

/**
 * Periodic refresh of the async outbox count so `_testa.debug().network.pending`
 * has a recent value without making `debug()` itself async.
 */
function startPendingCountPoll(): void {
  if (typeof window === 'undefined') return;
  void refreshPendingCount();
  const intervalMs = 5_000;
  setInterval(() => {
    void refreshPendingCount();
  }, intervalMs);
}

async function refreshPendingCount(): Promise<void> {
  try {
    _lastPendingCount = await outboxCount();
  } catch {
    // ignore — debug snapshot tolerates stale value
  }
}

// ─── queue draining ────────────────────────────────────────────────────────

function drainQueue(): void {
  const stub = window._testa;
  if (!stub) return;
  const queued = stub.q.slice();
  stub.q.length = 0;
  for (const call of queued) {
    replayCall(call);
  }
}

function replayCall(call: unknown): void {
  if (!Array.isArray(call) || call.length === 0) return;
  const [method, ...args] = call as [string, ...unknown[]];
  switch (method) {
    case 'track':
      trackCustomerEvent(args[0] as string, args[1] as Record<string, unknown> | undefined);
      break;
    case 'trackPurchase':
      trackCustomerEvent('purchase', {
        value_native: args[0] as number,
        currency: args[1] as string,
        order_id: args[2] as string,
        ...(args[3] !== undefined ? { items_count: args[3] as number } : {}),
      });
      break;
    case 'consent':
      consentMod.consent.setState(args[0] as ConsentState);
      break;
    case 'identify':
      // no-op for now (see installLiveApi)
      break;
    case 'navigate':
      window.dispatchEvent(new CustomEvent(LOCATIONCHANGE_EVENT));
      break;
  }
}

// ─── tracking ──────────────────────────────────────────────────────────────

/**
 * Live `track()`. Stamps the event with a UUIDv7 id, enqueues to the durable
 * outbox, and signals the transport to flush.
 *
 * Strict-consent gating: when consent.isHeld() is true, the event is parked
 * in a held queue (bounded at MAX_HELD_EVENTS, FIFO eviction) and replayed
 * when consent flips to 'granted'. A flip to 'denied' discards the queue.
 *
 * The in-memory `_pendingEvents` mirror is preserved as an inspection /
 * test hook; production callers should treat the outbox as the source of
 * truth.
 */
export function track(name: string, props?: Record<string, unknown>): void {
  const ts = Date.now();
  if (consentMod.consent.isHeld()) {
    holdEvent(name, props, ts);
    return;
  }
  emitTracked(name, props, ts);
}

/**
 * Customer-fired event entry point (`_testa.track` / `Analytica.pushEvent` /
 * `trackPurchase`). Emits through the normal `track` pipe AND runs custom-goal
 * matching, so a customer event whose name equals a `custom` goal's `action`
 * records a conversion. Internal emits (experiment_view, page_view, session_start,
 * conversion) call `track` directly and are NOT matched against goals.
 */
export function trackCustomerEvent(name: string, props?: Record<string, unknown>): void {
  track(name, props);
  _goals?.handleCustomEvent(name, props);
}

/**
 * Pre-redirect path: build the event sync, ship it via sendBeacon
 * synchronously, AND enqueue to the outbox as a backup. This closes the SRM
 * gap that would otherwise under-count redirect-variant exposures.
 *
 * - sendBeacon is the only API guaranteed to deliver during navigation.
 * - The outbox backup covers the case where beacon returns false (rare,
 *   usually quota): the event survives in IDB and the next pageload's
 *   transport flushes it. We do NOT mark sent on the outbox — if the beacon
 *   succeeds AND the next page also flushes, the collector dedups by
 *   event_id. UUIDv7 keeps the same id across both paths.
 */
function trackSyncForRedirect(name: string, props: Record<string, unknown>): void {
  const ts = Date.now();
  const exp = stampOrDrop(name, ts);
  if (exp === null) return;
  const event = buildPixelEvent(name, props, ts, exp);
  const payload = JSON.stringify(event);
  _pendingEvents.push({ name, props, ts, event });
  // Synchronous beacon — must run BEFORE location.replace().
  shipEventSync(payload);
  // Outbox backup — survives if beacon was rejected.
  void outboxEnqueue({ event_id: event.event_id, payload });
}

function emitTracked(name: string, props: Record<string, unknown> | undefined, ts: number): void {
  const exp = stampOrDrop(name, ts);
  if (exp === null) return;
  const event = buildPixelEvent(name, props ?? {}, ts, exp);
  const payload = JSON.stringify(event);
  _pendingEvents.push({ name, props: props ?? {}, ts, event });
  void outboxEnqueue({ event_id: event.event_id, payload }).then(() => {
    notifyEnqueue();
  });
}

// ─── PRD-006 experiment sessions (v2 experiments only) ────────────────────

/** Events sent even with no active experiment session (PRD §5.3). */
const SESSIONLESS_EVENTS = new Set(['experiment_view', '_pixel_health']);

/** Active experiments the project runs on the PRD-006 pipeline (`platform_version: 'v2'`). */
function v2ExperimentIds(project: ProjectConfig | undefined = readProject()): Set<number> {
  const ids = new Set<number>();
  for (const e of project?.experiments ?? []) {
    if (e.status === 'active' && e.platform_version === 'v2') ids.add(e.experiment_id);
  }
  return ids;
}

/**
 * `exp` for an event about to be sent, or `null` to drop it. A project with no
 * v2 experiment is untouched (`[]`, nothing dropped). Otherwise the event gets
 * the active v2 sessions, slides them, and is dropped (and counted) when none
 * is active — except experiment_view / _pixel_health.
 */
function stampOrDrop(name: string, ts: number): ExpSession[] | null {
  const v2 = v2ExperimentIds();
  if (v2.size === 0) return [];
  const exp = expSessions.activeExp(v2, ts);
  if (exp.length === 0 && !SESSIONLESS_EVENTS.has(name)) {
    recordDroppedNoSession();
    return null;
  }
  expSessions.touch(exp, ts);
  return exp;
}

let _reportedNoSessionDrops = 0;
let _healthFlushInstalled = false;

/**
 * PRD §5.3: events dropped for lack of a session "are counted in
 * `_pixel_health.props.dropped_no_session`". On the v2 pipeline, report the
 * drops since the last report once per page (on pagehide), shipped
 * synchronously like the redirect path so it survives the unload.
 */
export function reportDroppedNoSession(): void {
  if (v2ExperimentIds().size === 0) return;
  const snap = healthSnapshot(0);
  const delta = (snap.dropped_no_session ?? 0) - _reportedNoSessionDrops;
  if (delta <= 0) return;
  _reportedNoSessionDrops += delta;
  trackSyncForRedirect('_pixel_health', { ...snap, dropped_no_session: delta });
}

function installHealthFlush(): void {
  if (_healthFlushInstalled || typeof addEventListener !== 'function') return;
  _healthFlushInstalled = true;
  addEventListener('pagehide', reportDroppedNoSession);
}

// ─── strict-mode held-event replay ────────────────────────────────────────

interface HeldEvent {
  name: string;
  props: Record<string, unknown> | undefined;
  ts: number;
}

const MAX_HELD_EVENTS = 100;
let _heldEvents: HeldEvent[] = [];
let _consentReplayUnsub: (() => void) | null = null;

function holdEvent(name: string, props: Record<string, unknown> | undefined, ts: number): void {
  if (_heldEvents.length >= MAX_HELD_EVENTS) {
    // FIFO eviction; the dropped event would have been the oldest pre-consent
    // call. Note this in __pixel_debug so support escalations can see it.
    _heldEvents.shift();
    pushDebugError(
      'consent_hold_overflow',
      `dropped oldest held event; queue capped at ${MAX_HELD_EVENTS}`,
    );
  }
  _heldEvents.push({ name, props, ts });
}

/**
 * Subscribes to consent state changes; when consent flips to 'granted' under
 * strict mode, drains the held-events queue in original-ts order. Drops
 * everything if state flips to 'denied' (the strict contract is "no tracking
 * unless explicitly granted").
 */
function installConsentReplay(): void {
  _consentReplayUnsub?.();
  _consentReplayUnsub = consentMod.consent.subscribe((next) => {
    if (next === 'granted' && _heldEvents.length > 0) {
      const drained = _heldEvents;
      _heldEvents = [];
      for (const ev of drained) emitTracked(ev.name, ev.props, ev.ts);
    } else if (next === 'denied') {
      _heldEvents = [];
    }
  });
}

/**
 * Build a wire-format PixelEvent. Lifts well-known props (experiment_id,
 * variation_id, value_native, currency, order_id, items_count) onto top-level
 * fields so the collector can index them without poking into the props bag;
 * everything else stays in `props`.
 */
function buildPixelEvent(
  name: string,
  props: Record<string, unknown>,
  ts: number,
  exp: ExpSession[],
): PixelEvent {
  const project = readProject();
  const visitorId = cookies.getUuid() ?? generateEphemeralVisitorId();
  const sessionId = getOrCreateSessionId();
  _lastSessionId = sessionId;
  const consentState = consentMod.consent.getState();

  const { lifted, rest } = liftReservedProps(props);
  const search = typeof location !== 'undefined' ? location.search : '';
  const utms = readUtms(search);
  const v2Pipeline = v2ExperimentIds(project).size > 0;
  // Session-entry attribution: captured on the browsing session's first page
  // (first event), stamped on experiment_view only (PRD §5.3).
  const entry = entryFor(sessionId);
  const visitNumber = readVisitNumber();
  const href = typeof location !== 'undefined' ? location.href : '';

  const event: PixelEvent = {
    event_id: uuidv7(ts),
    event_name: name,
    client_ts: ts,
    project_id: project?.project_id ?? 0,
    visitor_id: visitorId,
    session_id: sessionId,
    // Click-id values never leave the browser on the v2 pipeline (type only).
    url: v2Pipeline ? stripClickIds(href) : href,
    consent_state: consentState,
    tracker_version: TRACKER_VERSION,
    viewport_w: typeof window !== 'undefined' ? window.innerWidth || 0 : 0,
    viewport_h: typeof window !== 'undefined' ? window.innerHeight || 0 : 0,
    screen_w: typeof screen !== 'undefined' ? screen.width || 0 : 0,
    screen_h: typeof screen !== 'undefined' ? screen.height || 0 : 0,
    exp,
    // PRD-006: in_experiment = notEmpty(exp), for projects on the v2 pipeline.
    ...(v2Pipeline ? { in_experiment: exp.length > 0 ? 1 : 0 } : {}),
    ...(visitNumber > 0 ? { visit_number: visitNumber } : {}),
    ...(name === 'experiment_view' ? entry : {}),
    ...(typeof document !== 'undefined' && document.referrer
      ? { referrer: document.referrer }
      : {}),
    ...lifted,
    ...utms,
    ...(Object.keys(rest).length > 0 ? { props: coerceProps(rest) } : {}),
  };
  return event;
}

interface LiftedProps {
  experiment_id?: number;
  variation_id?: number;
  value_native?: number;
  currency?: string;
  order_id?: string;
  items_count?: number;
}

function liftReservedProps(props: Record<string, unknown>): {
  lifted: LiftedProps;
  rest: Record<string, unknown>;
} {
  const lifted: LiftedProps = {};
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    switch (key) {
      case 'experiment_id':
      case 'variation_id':
      case 'value_native':
      case 'items_count':
        if (typeof value === 'number' && Number.isFinite(value)) {
          (lifted as Record<string, number>)[key] = value;
        }
        break;
      case 'currency':
      case 'order_id':
        if (typeof value === 'string' && value.length > 0) {
          (lifted as Record<string, string>)[key] = value;
        }
        break;
      default:
        rest[key] = value;
    }
  }
  return { lifted, rest };
}

/** Coerce arbitrary prop values to PixelEvent['props'] shape (string/number/boolean/null). */
function coerceProps(
  input: Record<string, unknown>,
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === null) {
      out[k] = null;
    } else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
    } else {
      // Stringify objects/arrays — collector ingests as a flat scalar bag.
      try {
        out[k] = JSON.stringify(v);
      } catch {
        out[k] = String(v);
      }
    }
  }
  return out;
}

/** Test/Phase 3.6 hook: read the in-memory event queue. */
export function __getPendingEventsForTests(): readonly PendingEvent[] {
  return _pendingEvents;
}

/** Test/Phase 3.6 hook: clear the in-memory event queue. */
export function __clearPendingEventsForTests(): void {
  _pendingEvents = [];
}

// ─── SPA listener (debounce + canonical URL diff via spa.ts) ───────────────

let _spaUninstall: (() => void) | null = null;

function installSpaListener(): void {
  // Idempotent: dispose any prior listener first.
  _spaUninstall?.();
  _spaUninstall = installSpaHandler({
    onTransition: () => {
      guardedInit('spa_cycle', () => {
        runExperimentCycle();
      });
    },
    // TODO(phase 3.x admin UI): wire `spa.hash_routes` per-project setting.
    includeHash: false,
  });
}

// ─── cross-domain (_testa_cd) ──────────────────────────────────────────────

let _crossDomainUninstall: (() => void) | null = null;

/** True when the experiment's session cookie is still within its sliding TTL. */
function isSessionActive(experimentId: number | string): boolean {
  if (v2ExperimentIds().has(Number(experimentId))) {
    return expSessions.isActive(expSessions.readSession(Number(experimentId)), Date.now());
  }
  const ts = cookies.getSession(experimentId);
  return ts !== null && Date.now() - ts < cookies.SESSION_LENGTH_SEC * 1000;
}

/** Experiments whose assignment should ride along on cross-domain navigations. */
function eligibleCrossDomain(): CrossDomainExperiment[] {
  const project = readProject();
  if (!project) return [];
  return eligibleCrossDomainExperiments(project.experiments, {
    getAssignment: cookies.getAssignment,
    isSessionActive,
  });
}

/**
 * Read an inbound `_testa_cd` param on the landing URL and apply the carried
 * assignments (assignment cookie + session bump), then strip the param from the
 * address bar. The uuid is mirrored in-memory only — the uuid cookie stays
 * worker-owned (see cross-domain.ts for the rationale).
 */
function applyInboundBridge(): void {
  if (typeof location === 'undefined') return;
  const result = applyInboundCrossDomain(
    { search: location.search, pathname: location.pathname, hash: location.hash },
    {
      setAssignment: cookies.setAssignment,
      bumpSession: cookies.bumpSession,
      onUuid: (uuid) => publishUuid(uuid),
    },
  );
  if (result.cleanedUrl !== null && typeof history !== 'undefined' && history.replaceState) {
    history.replaceState({}, '', result.cleanedUrl);
  }
}

/** Install outbound-link tagging (idempotent; disposes any prior install). */
function installCrossDomainLinks(): void {
  if (typeof document === 'undefined') return;
  _crossDomainUninstall?.();
  _crossDomainUninstall = installCrossDomainLinkTagging({
    doc: document,
    eligible: eligibleCrossDomain,
    getUuid: cookies.getUuid,
    currentHref: () => (typeof location !== 'undefined' ? location.href : ''),
  });
}

/**
 * Build the navigate function the redirect engine uses for a redirecting
 * variation. For `cross_domain` experiments crossing a domain boundary, the
 * destination is tagged with `_testa_cd` before we replace (3.3.3
 * `createRedirectUrl`'s cross-domain branch); otherwise the plain replace.
 */
function redirectNavigate(crossDomain: boolean): (url: string) => void {
  return (url: string) => {
    if (typeof window === 'undefined') return;
    let finalUrl = url;
    if (crossDomain) {
      const uuid = cookies.getUuid();
      if (uuid) {
        finalUrl = tagUrl(url, location.href, eligibleCrossDomain(), uuid);
      }
    }
    window.location.replace(finalUrl);
  };
}

// ─── experiment resolution cycle ───────────────────────────────────────────

/**
 * One pass over every experiment in the project config:
 *   1. Build EvalContext from cookies + DOM + cfPrefill.
 *   2. Filter experiments whose audience matches.
 *   3. assign() each match → cookie + variation_id (or excluded).
 *   4. For non-excluded matches: fire `experiment_view`, recordExposure.
 *   5. Variation application (DOM mutations) is deferred to Phase 3.9.
 *
 * Exported for tests + for Phase 3.5's SPA re-entry path.
 */
export function runExperimentCycle(): void {
  const project = readProject();
  if (!project) return;

  // Tear down DOM watchers from the previous cycle (SPA route change leaves
  // stale MutationObservers otherwise).
  for (const t of _activeTeardowns) {
    try {
      t();
    } catch {
      // ignore
    }
  }
  _activeTeardowns = [];

  // Tear down last cycle's goal listeners; start a fresh controller for this
  // pass (SPA re-entry otherwise leaves stale click handlers attached).
  _goals?.teardown();
  _goals = createGoalController({ track });

  // Fire session_start (new session only) + page_view for this URL. These are
  // the raw events goals match against at query time; page_view also re-fires
  // on every SPA navigation. On the PRD-006 pipeline they fire AFTER the
  // experiment loop instead, so they land inside the experiment session (§5.3).
  const v2 = v2ExperimentIds(project);
  if (v2.size === 0) fireLifecycleEvents();
  const pageUrl = typeof location !== 'undefined' ? location.href : '';

  const ctx = buildEvalContext();
  const stats = { matched: 0, excluded: 0 };
  const assigned: AssignedExperiment[] = [];

  // Randomized evaluation order — 3.3.3 `shuffleArray` parity, but
  // deterministic per visitor (same reasoning as hash bucketing: no SRM, no
  // cross-pageview flip-flop). With mutual exclusions + 100% traffic on N
  // experiments this splits NEW visitors evenly between them.
  for (const expConfig of shuffleForVisitor(project.experiments, cookies.getUuid() ?? '')) {
    if (expConfig.status !== 'active') continue;

    if (expConfig.audience !== undefined && !evaluate(expConfig.audience, ctx)) {
      stats.excluded += 1;
      continue;
    }

    const exp = toTrafficExperiment(expConfig);
    const result: AssignResult = assign(exp, { visitorId: ctx.visitor.uuidOrSession });

    if (result.isExcluded) {
      stats.excluded += 1;
      continue;
    }

    stats.matched += 1;

    // Session + exposure. v2: PRD-006 experiment session (re-init when expired,
    // §6.1); v1: the legacy session bump.
    const isV2 = v2.has(expConfig.experiment_id);
    if (isV2) expSessions.ensureSession(expConfig.experiment_id, result.variationId, Date.now());
    else cookies.bumpSession(expConfig.experiment_id);
    recordExposure(exp);

    const variation = expConfig.variations.find((v) => v.variation_id === result.variationId);
    const redirectChange = variation?.changes.find((c) => c.type === 'redirect');

    // GTM real-time exposure signal (3.3.3 `trackLead`) + collect this
    // experiment's goals for wiring after the loop. Pushed even when the
    // variation will redirect, since the page is about to change.
    pushLeadToDataLayer({
      experimentId: expConfig.experiment_id,
      ...(expConfig.title !== undefined ? { experimentName: expConfig.title } : {}),
      variationId: result.variationId,
      ...(variation?.name !== undefined ? { variationName: variation.name } : {}),
    });
    assigned.push({
      experimentId: expConfig.experiment_id,
      variationId: result.variationId,
      goals: expConfig.goals,
    });

    // SRM fix: when this variation will redirect, ship the experiment_view
    // SYNCHRONOUSLY via sendBeacon BEFORE we lose the page. The normal
    // outbox path is async (IDB write + 500ms flush debounce), so without
    // this the event would race the navigation and frequently lose,
    // under-counting the redirect variant vs control.
    const willRedirect =
      redirectChange?.type === 'redirect' &&
      !consentMod.consent.isHeld() &&
      typeof location !== 'undefined';

    // experiment_view to the edge: v2 experiments only when the page matches
    // the experiment (re-init on any page keeps the session, §6.1); v1
    // experiments of a project on the v2 pipeline send none (R1). Projects
    // without v2 experiments are unchanged.
    const sendView = v2.size === 0 || (isV2 && matchesPageRule(pageUrl, expConfig.rules ?? []));
    if (sendView && willRedirect) {
      trackSyncForRedirect('experiment_view', {
        experiment_id: expConfig.experiment_id,
        variation_id: result.variationId,
      });
    } else if (sendView) {
      track('experiment_view', {
        experiment_id: expConfig.experiment_id,
        variation_id: result.variationId,
      });
    }

    if (!variation || variation.changes.length === 0) continue;

    // Redirects run BEFORE other variation changes — if we're navigating
    // away, applying DOM mutations on a page that's about to unload is wasted
    // work and risks visible flicker. The currentUrl is snapshotted ONCE
    // here so the redirect engine never reads `location` directly during
    // its merge (Next.js race-condition fix).
    if (redirectChange?.type === 'redirect') {
      const outcome = evaluateRedirect(
        {
          experiment_id: expConfig.experiment_id,
          variation_id: result.variationId,
          change: redirectChange,
          currentUrl: typeof location !== 'undefined' ? location.href : '',
        },
        redirectNavigate(expConfig.cross_domain === true),
      );
      if (outcome.fired) {
        // Page is going away — abort the rest of the cycle.
        return;
      }
    }

    // Non-redirect changes (css/html/text/attribute/js).
    const nonRedirect = variation.changes.filter((c) => c.type !== 'redirect');
    if (nonRedirect.length > 0) {
      const teardowns = applyVariation(result.variationId, nonRedirect);
      _activeTeardowns.push(...teardowns);
    }

    // Fire 3.6-compatible legacy events (variation_assigned + variation_applied)
    // so customer code listening via Analytica.eventEmitter.on(...) keeps working.
    fireEvent('variation_assigned', {
      experiment: expConfig.experiment_id,
      variation: result.variationId,
    });
    fireEvent('variation_applied', {
      experiment: expConfig.experiment_id,
      variation: result.variationId,
    });
  }

  if (v2.size > 0) fireLifecycleEvents();

  // Wire click + page_view goals for every assigned experiment. Click goals
  // attach listeners only to their configured selectors (no click autocapture);
  // page_view goals fire immediately if the current URL matches; custom goals
  // wait for a matching customer event via `trackCustomerEvent`.
  _goals.register(assigned, ctx.page.url);

  pushDebug({
    ts: Date.now(),
    url: location.href,
    matchedExperiments: stats.matched,
    excludedExperiments: stats.excluded,
  });
}

/**
 * Fire the per-cycle behavioural events: `session_start` once per new session
 * (detected by the absence of the session cookie BEFORE any track mints one),
 * then `page_view` for the current URL. `page_view` re-fires on every SPA
 * navigation; `session_start` does not (the cookie exists by then).
 */
function fireLifecycleEvents(): void {
  const hadSession = Boolean(readValue(SESSION_ID_COOKIE));
  if (!hadSession) {
    track('session_start');
  }
  track('page_view');
}

// ─── EvalContext construction ─────────────────────────────────────────────

interface BuildVisitorContext {
  isReturning: boolean;
  cookies: Map<string, string>;
  uuidOrSession: string;
  dataLayer?: Record<string, unknown>;
}

function buildEvalContext(): EvalContext & { visitor: BuildVisitorContext } {
  const uuid = cookies.getUuid();
  const isReturning = uuid !== null;
  const visitorId = uuid ?? generateEphemeralVisitorId();

  const cookieMap = new Map<string, string>();
  if (typeof document !== 'undefined' && document.cookie) {
    for (const part of document.cookie.split(';')) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      cookieMap.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
    }
  }

  const geo = window.cfGeoData ?? {};
  const dl = (window as unknown as { dataLayer?: Array<Record<string, unknown>> }).dataLayer;
  const flatDl = Array.isArray(dl) && dl[0] && typeof dl[0] === 'object' ? dl[0] : undefined;

  return {
    page: {
      url: location.href,
      referrer: typeof document !== 'undefined' ? document.referrer : '',
    },
    visitor: {
      isReturning,
      cookies: cookieMap,
      uuidOrSession: visitorId,
      ...(flatDl !== undefined ? { dataLayer: flatDl } : {}),
    },
    geo: {
      country: geo.country ?? '',
      region: geo.region ?? '',
    },
    device: {
      type: detectDeviceType(),
      browser: detectBrowser(navigator.userAgent || ''),
      os: detectOs(navigator.userAgent || ''),
      viewportWidth: window.innerWidth || 0,
      language: navigator.language || '',
    },
    now: Date.now(),
  };
}

function detectDeviceType(): EvalContext['device']['type'] {
  const ua = navigator.userAgent || '';
  if (!ua) return 'unknown';
  if (/Tablet|iPad/i.test(ua)) return 'tablet';
  if (/Mobile|Android|iPhone|iPod/i.test(ua)) return 'mobile';
  return 'desktop';
}

function generateEphemeralVisitorId(): string {
  // Used only when `_testa_uuid` is missing AND the worker hasn't set it
  // yet (first ever pageload before a successful /track round-trip).
  // crypto.randomUUID is in every modern browser + jsdom/happy-dom.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `ephem-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

// ─── conversions ───────────────────────────────────────────────────────────

function toTrafficExperiment(config: ExperimentConfig): Experiment {
  return {
    experiment_id: config.experiment_id,
    traffic_allocation: config.traffic_allocation,
    variations: config.variations.map((v) => ({
      variation_id: v.variation_id,
      weight: v.weight,
    })),
    ...(config.frequency_cap !== undefined ? { frequency_cap: config.frequency_cap } : {}),
    ...(config.mutex_group !== undefined ? { mutex_group: config.mutex_group } : {}),
  };
}

function readProject(): ProjectConfig | undefined {
  return window.cfPrefill?.project;
}

// ─── network transport ────────────────────────────────────────────────────

function installNetwork(): void {
  // Kick off async backend selection so the first track() doesn't pay it.
  void initOutbox();

  const apiUrl = window.cfPrefill?.apiUrl;
  if (!apiUrl) return;
  const endpoint = `${apiUrl.replace(/\/$/, '')}/track`;
  installTransport({ endpoint });
}

// ─── consent mode ──────────────────────────────────────────────────────────

function applyConsentMode(): void {
  const project = readProject();
  if (project?.consent_mode === 'strict') {
    consentMod.consent.setStrictMode(true);
  }
}

// ─── lifecycle plumbing ────────────────────────────────────────────────────

function fireReady(): void {
  publishLoaded();
  const stub = window._testa;
  stub?._loaded?.();
}

function ensurePixelDebug(): void {
  if (!window.__pixel_debug) {
    window.__pixel_debug = { cycles: [], errors: [] };
  }
}

function pushDebug(entry: PixelDebug['cycles'][number]): void {
  ensurePixelDebug();
  const log = window.__pixel_debug as PixelDebug;
  log.cycles.push(entry);
  if (log.cycles.length > MAX_DEBUG_ENTRIES) {
    log.cycles.splice(0, log.cycles.length - MAX_DEBUG_ENTRIES);
  }
}

function pushDebugError(phase: string, err: unknown): void {
  ensurePixelDebug();
  const log = window.__pixel_debug as PixelDebug;
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  log.errors.push({ ts: Date.now(), phase, message });
  if (log.errors.length > MAX_DEBUG_ENTRIES) {
    log.errors.splice(0, log.errors.length - MAX_DEBUG_ENTRIES);
  }
  // Surface as a synthetic event so 3.6's network module picks it up
  // when it lands. No transport yet → just queues.
  _pendingEvents.push({
    name: '_pixel_health',
    props: { error_phase: phase, error_message: message },
    ts: Date.now(),
  });
}

function guardedInit(phase: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    pushDebugError(phase, err);
  }
}

/** Test reset hook. Forgets `_alreadyHydrated`, clears in-memory state. */
export function __resetForTests(): void {
  _pendingEvents = [];
  _reportedNoSessionDrops = 0;
  _heldEvents = [];
  _consentReplayUnsub?.();
  _consentReplayUnsub = null;
  _alreadyHydrated = false;
  _previewActive = false;
  _spaUninstall?.();
  _spaUninstall = null;
  _crossDomainUninstall?.();
  _crossDomainUninstall = null;
  _goals?.teardown();
  _goals = null;
  for (const t of _activeTeardowns) {
    try {
      t();
    } catch {
      // ignore
    }
  }
  _activeTeardowns = [];
}

// Audience type re-export for callers that don't want to depend on
// shared-types directly.
export type { AudienceCondition };
