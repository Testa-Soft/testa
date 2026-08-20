'use client';

import { onVariationApplied, type VariationEvent } from '@testa-soft/next';
import { useEffect, useState } from 'react';

/**
 * Demo-only event-handler testbed. Exercises the WHOLE client surface:
 *   - `testa.onVariationApplied` with TWO handlers (proves multi-handler),
 *   - both also `console.log` (browser console),
 *   - shows the GTM `window.dataLayer` `{ event: 'Analytica', ... }` pushes.
 * The SERVER hook (`onVariationAssigned`) logs to your terminal (dev server).
 * None of this ships in the SDK — it's the demo's stand-in for your analytics.
 */
export function TestaDebug() {
  const [events, setEvents] = useState<Array<{ h: string; d: VariationEvent }>>([]);
  const [dataLayer, setDataLayer] = useState<Array<Record<string, unknown>>>([]);

  useEffect(() => {
    // Handler #1
    const off1 = onVariationApplied((d) => {
      console.log('[testa] handler#1 variation_applied', d);
      setEvents((prev) => [...prev, { h: '#1', d }]);
    });
    // Handler #2 — same event, second subscriber (multi-handler)
    const off2 = onVariationApplied((d) => {
      console.log('[testa] handler#2 variation_applied', d);
      setEvents((prev) => [...prev, { h: '#2', d }]);
    });

    // Mirror the GTM dataLayer 'Analytica' pushes into the panel.
    const w = window as unknown as { dataLayer?: Array<Record<string, unknown>> };
    const snap = () => setDataLayer((w.dataLayer ?? []).filter((e) => e.event === 'Analytica'));
    snap();
    const t = setInterval(snap, 500);

    return () => {
      off1();
      off2();
      clearInterval(t);
    };
  }, []);

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 12,
        right: 12,
        width: 340,
        maxHeight: '45vh',
        overflow: 'auto',
        background: '#111',
        color: '#eee',
        font: '12px/1.4 ui-monospace, monospace',
        padding: 12,
        borderRadius: 8,
        zIndex: 99999,
        boxShadow: '0 4px 20px rgba(0,0,0,.4)',
      }}
    >
      <strong style={{ color: '#7ee' }}>testa events</strong>
      <div style={{ marginTop: 6, color: '#9f9' }}>
        variation_applied ({events.length}) — 2 handlers
      </div>
      {events.length === 0 && <div style={{ color: '#888' }}>none yet — visit /pricing or /</div>}
      {events.map((e, i) => (
        <div key={i} style={{ marginTop: 4 }}>
          <span style={{ color: '#fc6' }}>{e.h}</span> exp={e.d.experiment} var={e.d.variation}{' '}
          <span style={{ color: '#888' }}>{e.d.title}</span>
        </div>
      ))}
      <div style={{ marginTop: 10, color: '#9cf' }}>dataLayer 'Analytica' ({dataLayer.length})</div>
      {dataLayer.map((d, i) => (
        <div key={i} style={{ color: '#bbb', marginTop: 2 }}>
          Exp {String(d.ExperimentId)} → {String(d.VariationName)}
        </div>
      ))}
    </div>
  );
}
