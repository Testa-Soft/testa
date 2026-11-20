/**
 * Legacy crobot tracking — the exposure (`POST /api/leads`) and conversion
 * (`POST /api/leads/convert`) calls every experiment makes, v1 and v2 alike.
 * crobot's v1 results are a pure aggregate of the `leads` +
 * `lead_completed_goals` rows these create, so without them a pixel site shows
 * no results at all. Same payloads as the 3.3.3 pixel and the React/Next SDKs
 * (`packages/react/src/tracking.ts`, `packages/dom/src/goals/convert.ts`).
 *
 * - Fire-and-forget, `keepalive` (an exposure must survive a split-URL
 *   redirect fired right after it); never throws into the customer's page.
 * - GDPR: URL + title scrubbed, goal data PII-stripped (same scrubbers as the
 *   SDKs and the edge).
 * - Strict consent: while consent is held the calls are parked and replayed on
 *   grant, dropped on deny — the same contract as the `/track` held queue.
 * - Per-load dedup; crobot dedups server-side too (one lead per
 *   `(experiment, uuid)`, one completion per `(lead, goal)`).
 */

import { redactText, scrubProps, scrubUrl } from '@testa-soft/experiment-core';

/** Same default as `@testa-soft/react` (`DEFAULT_TRACKING_HOST`). */
export const DEFAULT_TRACKING_HOST = 'https://new.testa-soft.tech';
const MAX_HELD = 100;

export interface LegacyExposure {
  /** crobot numeric project id (ProjectConfig.project_id). */
  project_id: number;
  /** Experiment IDENTIFIER. */
  experiment: number;
  /** Variation IDENTIFIER (0 = control). */
  variation: number;
  uuid: string;
  title?: string;
  url: string;
}

export interface LegacyConversion {
  goal_id: number;
  action: string;
  lead_uuid: string;
  variation: number;
  data: Record<string, unknown>;
}

export interface LegacyTrackerDeps {
  host: string;
  /** True while strict consent is pending — calls are parked. */
  isHeld: () => boolean;
  fetchImpl?: typeof fetch;
}

export interface LegacyTracker {
  exposure: (payload: LegacyExposure) => void;
  conversion: (payload: LegacyConversion) => void;
  /** Consent resolved: replay (`granted`) or drop (`denied`) the parked calls. */
  onConsent: (state: string) => void;
}

interface Call {
  path: '/api/leads' | '/api/leads/convert';
  body: Record<string, unknown>;
}

export function createLegacyTracker(deps: LegacyTrackerDeps): LegacyTracker {
  const base = deps.host.replace(/\/+$/, '');
  const sent = new Set<string>();
  let held: Call[] = [];

  const post = (call: Call): void => {
    const doFetch = deps.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
    if (!doFetch) return;
    try {
      void doFetch(`${base}${call.path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(call.body),
        keepalive: true,
      }).catch(() => undefined);
    } catch {
      // never break the host page
    }
  };

  const send = (key: string, call: Call): void => {
    if (sent.has(key)) return;
    sent.add(key);
    if (deps.isHeld()) {
      held = [...held.slice(held.length >= MAX_HELD ? 1 : 0), call];
      return;
    }
    post(call);
  };

  return {
    exposure(p) {
      if (!p.uuid) return;
      const body = {
        ...p,
        url: scrubUrl(p.url),
        ...(p.title !== undefined ? { title: redactText(p.title) } : {}),
      };
      send(`x:${p.experiment}:${p.variation}:${p.uuid}`, { path: '/api/leads', body });
    },
    conversion(p) {
      if (!p.lead_uuid) return;
      const body = { ...p, data: scrubProps(p.data) };
      send(`c:${p.goal_id}:${p.lead_uuid}`, { path: '/api/leads/convert', body });
    },
    onConsent(state) {
      if (state === 'granted') {
        const calls = held;
        held = [];
        for (const c of calls) post(c);
      } else if (state === 'denied') {
        held = [];
      }
    },
  };
}
