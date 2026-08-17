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
}

export const TestaContext = createContext<TestaContextValue>({
  config: null,
  assignments: new Map(),
});
