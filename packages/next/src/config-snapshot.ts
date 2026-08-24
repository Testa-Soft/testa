/**
 * Process-wide config snapshot, shared through `globalThis`.
 *
 * Written by the instrumentation poller (`registerTestaConfig`) — or by a
 * customer's own push mechanism — and read synchronously by everything that
 * needs a config without awaiting a fetch: `ConfigClient` (both proxies) and
 * `loadTestaConfig` (RSC surface).
 *
 * `globalThis` is deliberate, not laziness: the writer (instrumentation.ts)
 * and the readers (middleware, server components) live in DIFFERENT bundles of
 * this package inside the customer's build, so module-scope state would give
 * each bundle its own private copy. A single well-known global key is the only
 * memory the copies share. (In the edge-runtime middleware sandbox even
 * `globalThis` is isolated — the snapshot is simply never found there and
 * readers fall back to their fetch paths.)
 */

import type { ProjectConfig } from '@testa-platform/shared-types';

interface SnapshotEntry {
  readonly config: ProjectConfig;
  readonly fetchedAtMs: number;
}

type SnapshotStore = Record<string, SnapshotEntry>;

const STORE_KEY = '__TESTA_CONFIG_SNAPSHOTS__';

function store(): SnapshotStore {
  const host = globalThis as Record<string, unknown>;
  const existing = host[STORE_KEY];
  if (existing && typeof existing === 'object') return existing as SnapshotStore;
  const fresh: SnapshotStore = {};
  host[STORE_KEY] = fresh;
  return fresh;
}

/** Last polled/pushed config for a project, or null when no writer has run. */
export function readConfigSnapshot(projectId: string): ProjectConfig | null {
  return store()[projectId]?.config ?? null;
}

/** Age of the snapshot in ms (against the writer's clock), or null when absent. */
export function configSnapshotAgeMs(projectId: string, nowMs: number): number | null {
  const entry = store()[projectId];
  return entry ? nowMs - entry.fetchedAtMs : null;
}

/** Publish a config snapshot for a project (replaces any previous one). */
export function writeConfigSnapshot(
  projectId: string,
  config: ProjectConfig,
  fetchedAtMs: number,
): void {
  store()[projectId] = { config, fetchedAtMs };
}

/** Remove one project's snapshot (or all of them) — tests and shutdown paths. */
export function clearConfigSnapshot(projectId?: string): void {
  const host = globalThis as Record<string, unknown>;
  if (projectId === undefined) {
    delete host[STORE_KEY];
    return;
  }
  delete store()[projectId];
}
