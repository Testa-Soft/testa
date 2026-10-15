/**
 * Resolve a project's config by its numeric `project_id` (what events, the
 * sync API and subscriptions carry). Crobot publishes configs keyed by project
 * UUID; the store indexes them by numeric id too (`getByProjectId`).
 */
import type { ProjectConfig } from '@testa-platform/shared-types';
import type { ConfigStore } from '../config/store.ts';

export async function configForProject(
  store: ConfigStore,
  projectId: number,
): Promise<ProjectConfig | null> {
  return store.getByProjectId ? store.getByProjectId(projectId) : store.get(String(projectId));
}
