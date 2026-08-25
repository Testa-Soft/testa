/**
 * Should the Pages Router head shield be rendered on this pass?
 *
 * Pulled out of the component so the rule is unit-testable without a React
 * renderer or a Next.js router — the component is then only glue.
 *
 * The rule, in order:
 *   - `shield: false` — the app owns anti-flicker; never render.
 *   - no Pages Router — `next/head` does nothing in the App Router, so the
 *     /pages provider mounted there degrades to a no-op instead of shielding a
 *     page it can never reveal.
 *   - an inline config with nothing to hide — no active experiment carries any
 *     change, so hiding the page would buy nothing. (With only a `projectId`
 *     the config is still in flight at first paint, which is precisely when the
 *     decision has to be made: shield, and reveal as soon as it lands.)
 *   - settled — the cycle finished; the shield's job is done.
 */

import type { ProjectConfig } from '@testa-platform/shared-types';
import type { ShieldOptions } from '@testa-soft/dom';
import { configNeedsShield } from '@testa-soft/react';

export interface ShieldDecisionInput {
  /** The provider's `shield` prop (`false` opts out; an object customises it). */
  shield?: boolean | ShieldOptions;
  /** The inline config, when the app passed one. */
  config?: ProjectConfig;
  /** Is a Pages Router mounted? (`next/compat/router` returns null if not.) */
  hasPagesRouter: boolean;
  /** Has the experiment cycle finished for this page? */
  settled: boolean;
}

export function shouldRenderHeadShield(input: ShieldDecisionInput): boolean {
  if (input.shield === false) return false;
  if (!input.hasPagesRouter) return false;
  if (input.config && !configNeedsShield(input.config)) return false;
  return !input.settled;
}
