/**
 * Custom-event entry point for the SDK surface — the bridge between
 * `pushEvent('signup_done', {...})` in customer code and whichever goal
 * controllers are live this navigation cycle.
 *
 * The React/Next SDKs create one controller per apply cycle (per soft nav);
 * customer code holds no reference to it. So controllers register themselves
 * here, and `pushEvent` fans the event out to all live ones. The legacy pixel
 * does NOT use this registry — it routes `_testa.track` to its own controller.
 *
 * `installGoalGlobals` exposes `pushEvent` as `window.testa.pushEvent` and —
 * for docs parity ("send events via window.Analytica.pushEvent") — as
 * `window.Analytica.pushEvent`, WITHOUT clobbering a real legacy pixel's
 * `Analytica` global if one is present.
 */

import type { GoalController } from './controller.ts';

const liveControllers = new Set<GoalController>();

/** Register a live controller; returns its unregister. */
export function registerGoalController(controller: GoalController): () => void {
  liveControllers.add(controller);
  return () => liveControllers.delete(controller);
}

/**
 * Fire a custom event by name against every live controller. Matching `custom`
 * goals record conversions; unknown names are a no-op. Safe to call anywhere
 * (SSR included — no-ops without a live controller).
 */
export function pushEvent(name: string, data?: Record<string, unknown>): void {
  for (const controller of liveControllers) {
    try {
      controller.handleCustomEvent(name, data);
    } catch {
      // a controller must never break the customer's event call
    }
  }
}

interface AnalyticaShim {
  pushEvent?: (name: string, data?: Record<string, unknown>) => void;
}

/**
 * Attach `pushEvent` to `window.testa` and `window.Analytica` so non-bundled
 * scripts / GTM Custom HTML can fire custom goals. Idempotent; never overwrites
 * an existing `pushEvent` (e.g. the legacy pixel's). No-op without `window`.
 */
export function installGoalGlobals(): void {
  if (typeof window === 'undefined') return;
  const w = window as unknown as {
    testa?: Record<string, unknown> & { pushEvent?: typeof pushEvent };
    Analytica?: AnalyticaShim;
  };
  // Property-assign (don't replace the objects): scripts may already hold a
  // reference to `window.testa` / `window.Analytica`.
  if (!w.testa) w.testa = { pushEvent };
  else if (!w.testa.pushEvent) w.testa.pushEvent = pushEvent;
  if (!w.Analytica) w.Analytica = { pushEvent };
  else if (!w.Analytica.pushEvent) w.Analytica.pushEvent = pushEvent;
}

/** Test hook — drop all live controllers. */
export function resetGoalRegistry(): void {
  liveControllers.clear();
}
