'use client';

import { pushEvent } from '@testa-soft/next';
import { useEffect, useState } from 'react';

const DWELL_MS = 3000;

/**
 * Dwell goal — fires the `watched_features` custom event after the visitor has
 * stayed on /features for 3 seconds. Leaving earlier (unmount on soft nav)
 * cancels the timer, so a drive-by visit never counts. The event converts any
 * assigned experiment with a `custom` goal whose action is `watched_features`.
 */
export function WatchedFeatures(): JSX.Element {
  const [fired, setFired] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      pushEvent('watched_features');
      setFired(true);
    }, DWELL_MS);
    return () => clearTimeout(timer);
  }, []);

  return (
    <p style={{ color: '#666', fontSize: 14 }}>
      Custom goal: <code>watched_features</code>{' '}
      {fired ? 'fired ✓ (3s dwell reached)' : 'fires after 3s on this page…'}
    </p>
  );
}
