'use client';

import { useEffect, useState } from 'react';

/**
 * Reload detector. `MOUNT_ID` is evaluated once when this client module first
 * loads in the browser and persists across soft (client-side) navigations; a
 * full page reload re-evaluates the module → new id.
 *
 * It's rendered via `useEffect` (client-only) rather than inline, so the server
 * and the client's FIRST render agree (both show the placeholder) — otherwise
 * the random value would differ between server and client and trigger a
 * hydration mismatch.
 */
const MOUNT_ID = Math.random().toString(36).slice(2, 8);

export function ReloadSentinel() {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => setId(MOUNT_ID), []);

  return (
    <p
      style={{
        fontSize: 13,
        color: '#888',
        marginTop: 24,
        borderTop: '1px solid #eee',
        paddingTop: 12,
      }}
    >
      client session id: <code>{id ?? '…'}</code> — unchanged across pages = no reload (soft nav);
      changed = full page reload.
    </p>
  );
}
