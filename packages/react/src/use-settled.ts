/**
 * `useTestaSettled` — has the experiment cycle finished for this page?
 *
 * The one thing a shield needs to know. `<TestaProvider/>` flips it once the
 * assigned variant is applied (or there was nothing to apply, or the config
 * failed to load and we fail open), and leaves it false while a split-URL
 * redirect is in flight — the page is on its way out, so nothing should be
 * revealed.
 *
 * A server-rendered shield uses this to unrender itself at exactly that moment:
 * see `<TestaProvider/>` in `@testa-soft/next/pages`. `false` outside a provider.
 */

import { useContext } from 'react';
import { TestaContext } from './context.ts';

export function useTestaSettled(): boolean {
  return useContext(TestaContext).settled;
}
