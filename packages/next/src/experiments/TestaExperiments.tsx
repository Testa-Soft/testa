'use client';

/**
 * `<TestaExperiments/>` — applies the visitor's assigned DOM experiments on the
 * client. Add it once in the layout (client component); it re-applies on each
 * App-Router navigation.
 *
 * Cookie-first: the middleware already bucketed the visitor server-side and
 * wrote `_testa_exp`; this reads that cookie and applies the variant's DOM
 * changes via the shared apply engine — no re-bucket, no config re-fetch. After
 * applying it reveals the anti-flicker shield (raised by `<TestaShield/>` in the
 * document head), so control content is never shown before the variant.
 *
 * All logic is in `apply-assignments.ts` (framework-agnostic, unit tested); this
 * file is the React + App-Router glue.
 */

import { ASSIGNMENT_COOKIE } from '@testa-platform/experiment-core';
import type { ProjectConfig } from '@testa-platform/shared-types';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { readClientCookie } from '../client-cookie.ts';
import { applyAssignedExperiments, revealShield } from './apply-assignments.ts';

export interface TestaExperimentsProps {
  /** The same ProjectConfig the middleware uses (local fixture or fetched once). */
  config: ProjectConfig;
}

export function TestaExperiments({ config }: TestaExperimentsProps): null {
  const pathname = usePathname();

  // `pathname` is intentionally a dependency: it's the re-apply trigger on
  // App-Router soft navigation, even though it isn't read in the effect body.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the re-run trigger
  useEffect(() => {
    const teardowns = applyAssignedExperiments(config, readClientCookie(ASSIGNMENT_COOKIE));
    // Content was hidden by the head shield; reveal it now the variant is applied.
    revealShield();
    return () => {
      for (const teardown of teardowns) {
        try {
          teardown();
        } catch {
          // never let a teardown break unmount / the next cycle
        }
      }
    };
    // Re-apply on route change (pathname); config identity is stable.
  }, [config, pathname]);

  return null;
}
