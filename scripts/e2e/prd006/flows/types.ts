/**
 * Flow model for the PRD-006 harness. A flow (V1…V17) is a list of checks;
 * each check ends pass / fail / pending (feature not built yet, never a pass)
 * / skipped (deliberately not run, e.g. perf on a shared machine). Outcomes
 * and the `Diff` collector come from X0's check model.
 */

import type { Outcome } from '../../cross/lib/check.ts';
import type { FixtureId, FlowId, HarnessConfig } from '../config.ts';
import type { WebhookReceiver } from '../stack.ts';
import type { SyncApi } from './api.ts';

export type { Outcome };
export { Diff, fail, pass, pending } from '../../cross/lib/check.ts';

export type CheckStatus = Outcome['status'] | 'skipped';

export interface CheckResult {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
  readonly expected?: unknown;
  readonly actual?: unknown;
  readonly pendingOn?: string;
  readonly ms: number;
}

export interface FlowResult {
  readonly id: FlowId;
  readonly title: string;
  readonly data: string;
  readonly checks: readonly CheckResult[];
  readonly ms: number;
}

export interface FlowCtx {
  readonly cfg: HarnessConfig;
  readonly api: SyncApi;
  readonly webhooks: WebhookReceiver;
  /** Values computed once per run (oracle models, ingest stats, …). */
  readonly facts: Map<string, unknown>;
}

export interface FlowDef {
  readonly id: FlowId;
  readonly title: string;
  /** Fixture(s) the flow reads, for the plan and `--only F1`. */
  readonly data: string;
  readonly fixtures: readonly FixtureId[];
  run(ctx: FlowCtx, check: CheckFn): Promise<void>;
}

export type CheckFn = (name: string, body: () => Promise<Outcome | SkipOutcome>) => Promise<void>;

export interface SkipOutcome {
  readonly status: 'skipped';
  readonly detail: string;
}

export const skipped = (detail: string): SkipOutcome => ({ status: 'skipped', detail });

/** Thrown when a check needs a fixture this run did not load (`--only`): the check is skipped. */
export class FixtureNotLoaded extends Error {}

export function fact<T>(ctx: FlowCtx, key: string): T {
  if (!ctx.facts.has(key))
    throw new FixtureNotLoaded(`${key.split('.')[0]?.toUpperCase()} not loaded in this run`);
  return ctx.facts.get(key) as T;
}

/** §2.3 daily keys the harness subscribes (literal: scripts don't import workspace packages). */
export const BUILTIN_KEYS = [
  'purchase',
  'upsell',
  'revenue',
  'add_to_cart',
  'begin_checkout',
  'add_shipping_info',
  'add_payment_info',
  'generate_lead',
  'sign_up',
  'page_view',
  'units',
  'units_upsell',
  'units_added',
  'units_bought_from_cart',
  'coupon',
  'lead',
  'lead_purchase',
  'repeat_purchase',
  'cart_purchase',
  'checkout_purchase',
  'session',
] as const;
export const F1_KEYS = [...BUILTIN_KEYS, 'event:size_guide_opened', 'goal:12'];
export const F2_KEYS = [
  ...BUILTIN_KEYS,
  'event:size_guide_opened',
  'event:video_played',
  'event:review_opened',
  'goal:12',
  'goal:13',
  'goal:14',
];
