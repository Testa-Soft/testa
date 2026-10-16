/**
 * Config store — where the collector persists the servable `ProjectConfig` it
 * builds. testa-platform is the single source of truth for configs.
 *
 * v1: a static JSON file per project (`{dir}/{projectId}.json`). The directory
 * is the local stand-in for the object bucket / CDN origin we push configs (and
 * later events) to — so a file that can be served statically, "saved as is".
 *
 * `projectId` becomes a filename, so it is validated to a safe charset to
 * prevent path traversal.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectConfig } from '@testa-platform/shared-types';

const SAFE_PROJECT_ID = /^[A-Za-z0-9_-]+$/;

export const isSafeProjectId = (projectId: string): boolean => SAFE_PROJECT_ID.test(projectId);

export function assertSafeProjectId(projectId: string): void {
  if (!isSafeProjectId(projectId)) {
    throw new Error(`unsafe projectId: ${projectId}`);
  }
}

export const configFilename = (projectId: string): string => `${projectId}.json`;

export interface ConfigStore {
  put(projectId: string, config: ProjectConfig): Promise<void>;
  get(projectId: string): Promise<ProjectConfig | null>;
  /**
   * Look a config up by its numeric `ProjectConfig.project_id` (what events and
   * the sync API carry), whatever key it was stored under (crobot publishes by
   * project UUID). Falls back to a config stored under the numeric id itself.
   */
  getByProjectId?(projectId: number): Promise<ProjectConfig | null>;
}

/** Index dir: `{dir}/_by-project-id/{numericId}.json` → `{ "key": "<store key>" }`. */
export const PROJECT_ID_INDEX_DIR = '_by-project-id';

export function fileConfigStore(dir: string): ConfigStore {
  const pathFor = (projectId: string): string => {
    assertSafeProjectId(projectId);
    return join(dir, configFilename(projectId));
  };

  return {
    async put(projectId, config) {
      const path = pathFor(projectId);
      await mkdir(dir, { recursive: true });
      // Pretty-printed so the bucket file is human-inspectable.
      await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
      // Numeric-id alias (the store key is usually crobot's project UUID).
      if (Number.isSafeInteger(config.project_id) && config.project_id > 0) {
        const indexDir = join(dir, PROJECT_ID_INDEX_DIR);
        await mkdir(indexDir, { recursive: true });
        await writeFile(
          join(indexDir, `${config.project_id}.json`),
          `${JSON.stringify({ key: projectId })}\n`,
          'utf8',
        );
      }
    },

    async get(projectId) {
      const path = pathFor(projectId);
      let raw: string;
      try {
        raw = await readFile(path, 'utf8');
      } catch {
        return null; // absent file → no config
      }
      try {
        return JSON.parse(raw) as ProjectConfig;
      } catch {
        return null;
      }
    },

    async getByProjectId(projectId) {
      if (!Number.isSafeInteger(projectId) || projectId <= 0) return null;
      let key: unknown;
      try {
        const raw = await readFile(join(dir, PROJECT_ID_INDEX_DIR, `${projectId}.json`), 'utf8');
        key = (JSON.parse(raw) as { key?: unknown }).key;
      } catch {
        key = undefined; // no alias → maybe stored under the numeric id itself
      }
      if (typeof key === 'string' && SAFE_PROJECT_ID.test(key)) {
        const config = await this.get(key);
        if (config?.project_id === projectId) return config;
      }
      return this.get(String(projectId));
    },
  };
}
