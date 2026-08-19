'use client';

import { onVariationApplied } from '@testa-soft/next';
import { useEffect } from 'react';

/**
 * Demo-only: log every client `variation_applied` event to the browser console.
 * Proves the event bus fires (split-URL after the redirect + DOM on the page),
 * and you'll also see a `{ event: 'Analytica', ... }` entry pushed to
 * `window.dataLayer`. Register returns an unsubscribe → useEffect cleanup.
 */
export function TestaDebug() {
  useEffect(
    () =>
      onVariationApplied((d) => {
        // eslint-disable-next-line no-console
        console.log('[testa] variation_applied', d);
      }),
    [],
  );
  return null;
}
