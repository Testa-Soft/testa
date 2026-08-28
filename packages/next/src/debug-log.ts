/**
 * Ship the debug trace to crobot's `/log` endpoint (3.3.3 `sendLog` parity),
 * so a production decision can be inspected without log-drain access to the
 * customer's own deployment — which, on someone else's Vercel/k8s, we do not
 * have.
 *
 * Only ever active with `debug: true` (or `TESTA_DEBUG=1`). The request is made
 * BY THE SERVER, so unlike the browser beacon it cannot be blocked by an
 * extension or a CSP — the trade is that the recorded IP is the deployment's,
 * not the visitor's, which is why the trace carries the visitor id explicitly.
 *
 * Fire-and-forget and non-throwing: a diagnostic must never be able to fail the
 * request it is describing.
 */

import { type LogLevel, buildLogUrl } from '@testa-soft/experiment-core';

/** Level everything is sent at — these are diagnostics, not faults. */
const LEVEL: LogLevel = 'debug';

/**
 * GET the beacon. Returns the promise so the caller can hand it to
 * `event.waitUntil()`; it never rejects.
 */
export function sendDebugLog(
  trackingHost: string,
  payload: unknown,
  nonce: string | number,
): Promise<void> {
  const url = buildLogUrl(trackingHost, LEVEL, payload, nonce);
  if (!url) return Promise.resolve();
  try {
    return fetch(url, { method: 'GET', keepalive: true }).then(
      () => undefined,
      () => undefined,
    );
  } catch {
    return Promise.resolve();
  }
}

/**
 * The server's DECISION, in one flat line, shipped to crobot's `/log`.
 *
 * The proxy no longer creates leads — the browser does — so without this there
 * is no record of what the server concluded, only of what the client later
 * reported. That gap is precisely where a discrepancy hides: a lead whose URL
 * has lost its query params says nothing about whether the server saw them
 * either. Logged at `info` so it sits apart from the `debug` traces, and kept
 * to the join keys plus the two URLs so it stays cheap enough to leave on.
 *
 * `urlIn` is the URL exactly as it ARRIVED, before public-host recovery and
 * before Next's own params were stripped. `urlOut` is the destination we sent
 * them to, or null when we did not redirect. Comparing the two across many
 * decisions is what shows where a parameter set stops existing.
 */
export interface DecisionLog {
  /** The URL as it arrived on the wire. */
  urlIn: string;
  /** The redirect destination, or null when the request passed through. */
  urlOut: string | null;
  /** `_testa_uuid` as resolved for this request. */
  uuid: string;
  /** Every variation applied — empty when the visitor was excluded or unmatched. */
  applied: ReadonlyArray<{ experiment: number; variation: number; first: boolean }>;
  /** `document` = URL off the wire; `data` = a framework fetch the app addressed. */
  nav: 'document' | 'data';
  /** Present when the same-site Referer carried params this request did not. */
  dropped?: string[];
}

/** Ship a decision line. Never throws; returns a promise for `waitUntil`. */
export function sendDecisionLog(
  trackingHost: string,
  decision: DecisionLog,
  nonce: string | number,
): Promise<void> {
  const url = buildLogUrl(trackingHost, 'info', { testa: 'decision', ...decision }, nonce);
  if (!url) return Promise.resolve();
  try {
    return fetch(url, { method: 'GET', keepalive: true }).then(
      () => undefined,
      () => undefined,
    );
  } catch {
    return Promise.resolve();
  }
}
