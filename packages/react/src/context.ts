/**
 * React context carrying the resolved config + the current assignment map, so
 * `useTestaVariant` can read a visitor's variation without touching the DOM or
 * re-parsing cookies on its own. `<TestaProvider/>` owns and refreshes it (on
 * mount and on every SPA navigation).
 */

import type { ProjectConfig } from '@testa-platform/shared-types';
import { createContext } from 'react';

export interface TestaContextValue {
  config: ProjectConfig | null;
  /** experimentId → assigned variationId (excluded/no-variation entries dropped). */
  assignments: ReadonlyMap<number, number>;
  /**
   * True once the cycle has FINISHED for this page — the variant is applied, or
   * there was nothing to apply, or it failed open. Stays false while a split-URL
   * redirect is in flight (the page is leaving; nothing should be revealed).
   *
   * This is the signal an anti-flicker shield reveals on: `<TestaProvider/>`
   * reveals its own shield here, and a server-rendered shield (Pages Router)
   * reads it through {@link useTestaSettled} to stop rendering itself.
   */
  settled: boolean;
}

export const TestaContext = createContext<TestaContextValue>({
  config: null,
  assignments: new Map(),
  settled: false,
});
