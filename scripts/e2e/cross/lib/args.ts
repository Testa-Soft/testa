/**
 * CLI flags for `pnpm e2e:cross`.
 *
 *   --platform-dir <path>  testa-platform checkout whose collector/edge to run (default: this repo)
 *   --crobot-dir <path>    crobot worktree to serve as the e2e app (default: ~/projects/crobot/.worktrees/x0)
 *   --only <a,b>           layers (infra|smoke|contract|sync|ui|lifecycle|admin-v2) and/or check ids
 *   --keep-up              leave every process / container running after the run
 *   --down                 tear down a stack left by --keep-up and exit
 *   --strict               pending checks count as failures (exit 1) — X1 acceptance mode
 *   --no-edge              skip wrangler dev (edge smoke reports pending)
 *   --skip-crobot-setup    reuse the running e2e app as is (no migrate:fresh + seed)
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface CliArgs {
  readonly platformDir: string;
  readonly crobotDir: string;
  readonly only: readonly string[];
  readonly keepUp: boolean;
  readonly down: boolean;
  readonly strict: boolean;
  readonly edge: boolean;
  readonly crobotSetup: boolean;
}

const HARNESS_ROOT = resolve(import.meta.dir, '..', '..', '..', '..');

export function defaultArgs(): CliArgs {
  return {
    platformDir: HARNESS_ROOT,
    crobotDir: join(homedir(), 'projects', 'crobot', '.worktrees', 'x0'),
    only: [],
    keepUp: false,
    down: false,
    strict: false,
    edge: true,
    crobotSetup: true,
  };
}

export function parseArgs(argv: readonly string[]): CliArgs {
  let args = defaultArgs();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = (): string => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${flag} needs a value`);
      i += 1;
      return next;
    };
    switch (flag) {
      case '--platform-dir':
        args = { ...args, platformDir: resolve(value()) };
        break;
      case '--crobot-dir':
        args = { ...args, crobotDir: resolve(value()) };
        break;
      case '--only':
        args = { ...args, only: [...args.only, ...value().split(',').filter(Boolean)] };
        break;
      case '--keep-up':
        args = { ...args, keepUp: true };
        break;
      case '--down':
        args = { ...args, down: true };
        break;
      case '--strict':
        args = { ...args, strict: true };
        break;
      case '--no-edge':
        args = { ...args, edge: false };
        break;
      case '--skip-crobot-setup':
        args = { ...args, crobotSetup: false };
        break;
      case '--':
        break;
      default:
        throw new Error(`unknown flag ${flag} (see scripts/e2e/cross/lib/args.ts)`);
    }
  }
  return args;
}

export const harnessRoot = HARNESS_ROOT;
