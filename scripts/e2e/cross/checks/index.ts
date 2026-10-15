/** The full check catalogue, in execution order (layer order, then listed order). */

import type { CheckDef } from '../lib/check.ts';
import { contractIngestChecks } from './contract-ingest.ts';
import { contractSyncChecks } from './contract-sync.ts';
import { contractViewChecks } from './contract-views.ts';
import { infraChecks } from './infra.ts';
import { lifecycleChecks } from './lifecycle.ts';
import { smokeChecks } from './smoke.ts';
import { syncChecks } from './sync.ts';
import { uiChecks } from './ui.ts';

export const ALL_CHECKS: readonly CheckDef[] = [
  ...infraChecks,
  ...smokeChecks,
  ...contractIngestChecks,
  ...contractSyncChecks,
  ...contractViewChecks,
  ...syncChecks,
  ...uiChecks,
  ...lifecycleChecks,
];
