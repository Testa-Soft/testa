/**
 * Client-side experiment event bus — crobot 3.3.3 `eventEmitter` parity.
 *
 * The SDK EMITS two events; whatever handlers are registered consume them:
 *   - `variation_applied`  — the visitor was shown a variation (client-side,
 *                            once per session, on the applied page).
 *   - `variation_assigned` — the visitor was bucketed (mirrored client-side when
 *                            the client first observes a fresh server decision).
 *
 * Registration is via named functions (`onVariationApplied` / `onVariationAssigned`),
 * each supporting MULTIPLE handlers and each returning an unsubscribe fn. The bus
 * keeps 3.3.3's two ergonomics that matter:
 *   - HISTORY REPLAY: a handler registered AFTER an event fired still receives it
 *     (analytics scripts often load late), and
 *   - PER-HANDLER DEDUP: each handler sees each unique event at most once.
 *
 * `emitVariationApplied` also pushes the 3.3.3 GTM `dataLayer` shape by default
 * (not configurable). Exposed on `window.testa` too, for non-bundled scripts /
 * GTM Custom HTML (3.3.3 `window.Analytica.on` parity).
 */

/** Event payload — crobot 3.3.3 `leadData`. */
export interface VariationEvent {
  project_id: number;
  /** Experiment IDENTIFIER (0-based), not the DB pk. */
  experiment: number;
  /** Variation IDENTIFIER (0 = control). */
  variation: number;
  uuid: string;
  title?: string;
  url: string;
  /** True when freshly bucketed on this decision; false when served from cookie. */
  firstAssignment?: boolean;
}

export type VariationEventName = 'variation_applied' | 'variation_assigned';
export type VariationHandler = (event: VariationEvent) => void;
/** Remove a previously-registered handler. */
export type Unsubscribe = () => void;

/** 3.3.3 `CONTROL_IDENTIFIER` — variation 0 is always the control. */
const CONTROL_IDENTIFIER = 0;

interface Bus {
  handlers: Map<VariationEventName, Set<VariationHandler>>;
  history: Map<VariationEventName, VariationEvent[]>;
  processed: WeakMap<VariationHandler, Set<string>>;
}

const bus: Bus = { handlers: new Map(), history: new Map(), processed: new WeakMap() };

function key(event: VariationEvent): string {
  // Per-handler dedup key — one delivery per (experiment, variation) event.
  return `${event.experiment}:${event.variation}`;
}

function deliver(handler: VariationHandler, event: VariationEvent): void {
  let seen = bus.processed.get(handler);
  if (!seen) {
    seen = new Set();
    bus.processed.set(handler, seen);
  }
  const k = key(event);
  if (seen.has(k)) return;
  seen.add(k);
  try {
    handler(event);
  } catch {
    // a listener must never break the SDK / other listeners
  }
}

function on(name: VariationEventName, handler: VariationHandler): Unsubscribe {
  const set = bus.handlers.get(name) ?? new Set();
  set.add(handler);
  bus.handlers.set(name, set);
  // History replay — a handler added after the event fired still gets it.
  for (const past of bus.history.get(name) ?? []) deliver(handler, past);
  return () => bus.handlers.get(name)?.delete(handler);
}

function emit(name: VariationEventName, event: VariationEvent): void {
  const hist = bus.history.get(name) ?? [];
  hist.push(event);
  bus.history.set(name, hist);
  for (const handler of bus.handlers.get(name) ?? []) deliver(handler, event);
}

/** Register a handler for `variation_applied`. Multiple allowed; returns unsubscribe. */
export function onVariationApplied(handler: VariationHandler): Unsubscribe {
  return on('variation_applied', handler);
}

/** Register a handler for `variation_assigned`. Multiple allowed; returns unsubscribe. */
export function onVariationAssigned(handler: VariationHandler): Unsubscribe {
  return on('variation_assigned', handler);
}

/** Human-readable variation label (3.3.3): `Control` for id 0, else name or `Variation<id>`. */
function variationName(variationId: number, configuredName?: string): string {
  if (variationId === CONTROL_IDENTIFIER) return 'Control';
  return configuredName && configuredName.length > 0 ? configuredName : `Variation${variationId}`;
}

/** Push the 3.3.3 GTM `dataLayer` exposure shape. Always on (not configurable). */
function pushDataLayer(event: VariationEvent): void {
  if (typeof window === 'undefined') return;
  const w = window as unknown as { dataLayer?: Array<Record<string, unknown>> };
  if (!Array.isArray(w.dataLayer)) w.dataLayer = [];
  w.dataLayer.push({
    event: 'Analytica',
    ExperimentId: event.experiment,
    ExperimentName: event.title ?? '',
    VariationId: event.variation,
    VariationName: variationName(event.variation),
  });
}

// Once-per-page-load guard (3.3.3 `tracked[expId]`): a soft-nav re-apply or a
// re-render must not re-push the dataLayer or re-emit. Reset on a full reload.
const appliedThisLoad = new Set<string>();

/** Emit `variation_applied` to all handlers + push the GTM `dataLayer` (once per load). */
export function emitVariationApplied(event: VariationEvent): void {
  const k = key(event);
  if (appliedThisLoad.has(k)) return;
  appliedThisLoad.add(k);
  pushDataLayer(event);
  emit('variation_applied', event);
}

/** Emit `variation_assigned` to all handlers. */
export function emitVariationAssigned(event: VariationEvent): void {
  emit('variation_assigned', event);
}

/** The public `window.testa` surface (3.3.3 `window.Analytica.on` parity). */
export interface TestaGlobal {
  onVariationApplied: typeof onVariationApplied;
  onVariationAssigned: typeof onVariationAssigned;
}

/** Importable equivalent of `window.testa` — `import { testa } from '@testa-soft/next'`. */
export const testa: TestaGlobal = { onVariationApplied, onVariationAssigned };

/**
 * Attach `window.testa` so non-bundled scripts / GTM Custom HTML can subscribe.
 * Idempotent; safe to call from every client entrypoint. No-op without `window`.
 */
export function installTestaGlobal(): void {
  if (typeof window === 'undefined') return;
  const w = window as unknown as { testa?: TestaGlobal };
  if (!w.testa) w.testa = { onVariationApplied, onVariationAssigned };
}
