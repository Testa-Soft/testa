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

export function assertSafeProjectId(projectId: string): void {
  if (!SAFE_PROJECT_ID.test(projectId)) {
    throw new Error(`unsafe projectId: ${projectId}`);
  }
}

export const configFilename = (projectId: string): string => `${projectId}.json`;

export interface ConfigStore {
  put(projectId: string, config: ProjectConfig): Promise<void>;
  get(projectId: string): Promise<ProjectConfig | null>;
}

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
  };
}
