/**
 * The pixel's real `urlMatchesGoal` (packages/dom/src/goals/controller.ts),
 * loaded at runtime for parity tests. A dynamic import of a computed path:
 * the collector's tsconfig (rootDir src, no DOM lib) can't type-check the dom
 * package, and `@testa-soft/dom` exports only its browser entry.
 */
import { resolve } from 'node:path';
import type { MatchType } from '@testa-platform/shared-types';

export type UrlMatchesGoal = (url: string, pattern: string, matchType?: MatchType) => boolean;

const CONTROLLER = resolve(import.meta.dir, '../../../../packages/dom/src/goals/controller.ts');

export async function loadPixelUrlMatch(): Promise<UrlMatchesGoal> {
  const mod = (await import(CONTROLLER)) as { urlMatchesGoal: UrlMatchesGoal };
  return mod.urlMatchesGoal;
}
