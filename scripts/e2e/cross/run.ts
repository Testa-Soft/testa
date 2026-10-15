#!/usr/bin/env bun
/**
 * `pnpm e2e:cross` — cross-repo LIVE end-to-end harness (task X0).
 *
 * Brings up the real processes of both systems (testa-platform collector +
 * consumer + modeler + edge on the host, crobot e2e app in its own containers),
 * runs every check layer against them, writes `.artifacts/report.{json,md}`
 * and tears everything down unless `--keep-up`. No mocks at the boundary.
 *
 * Exit code: 1 if any check fails (or, with --strict, is pending); else 0.
 * Flags: see lib/args.ts. Topology: lib/config.ts. Scoreboard: docs/e2e/cross-repo.md.
 */

import { ALL_CHECKS } from './checks/index.ts';
import { parseArgs } from './lib/args.ts';
import {
  type CheckDef,
  type CheckResult,
  type Ctx,
  LAYERS,
  type Outcome,
  PendingError,
  fail,
  pending,
  statusLabel,
} from './lib/check.ts';
import { buildConfig } from './lib/config.ts';
import { errorMessage, log } from './lib/log.ts';
import { writeReport } from './lib/report.ts';
import { run } from './lib/shell.ts';
import { crobotDown, crobotUp } from './stack/crobot.ts';
import { platformDown, platformUp } from './stack/platform.ts';

/** Checks named by --only (layers, ids or id prefixes) plus everything they need. */
function selectChecks(only: readonly string[]): readonly CheckDef[] {
  if (only.length === 0) return ALL_CHECKS;
  const byId = new Map(ALL_CHECKS.map((c) => [c.id, c]));
  const unknown = only.filter(
    (t) =>
      !LAYERS.includes(t as never) &&
      !ALL_CHECKS.some((c) => c.id === t || c.id.startsWith(`${t}.`) || c.id.startsWith(t)),
  );
  if (unknown.length > 0) throw new Error(`--only: unknown layer/check ${unknown.join(', ')}`);
  const wanted = new Set<string>();
  const add = (id: string): void => {
    if (wanted.has(id)) return;
    wanted.add(id);
    for (const dep of byId.get(id)?.needs ?? []) add(dep);
  };
  for (const c of ALL_CHECKS) {
    if (only.some((t) => t === c.layer || c.id === t || c.id.startsWith(t))) add(c.id);
  }
  return ALL_CHECKS.filter((c) => wanted.has(c.id));
}

/** A check whose dependency didn't pass inherits that state instead of running. */
function blockedBy(check: CheckDef, done: ReadonlyMap<string, CheckResult>): Outcome | null {
  for (const dep of check.needs ?? []) {
    const r = done.get(dep);
    if (r === undefined) return fail(`dependency ${dep} did not run`);
    if (r.status === 'pending')
      return pending(r.pendingOn ?? '?', `blocked by ${dep}: ${r.detail}`);
    if (r.status === 'fail') return fail(`blocked: ${dep} failed`);
  }
  return null;
}

async function runCheck(
  check: CheckDef,
  ctx: Ctx,
  done: ReadonlyMap<string, CheckResult>,
): Promise<CheckResult> {
  const started = performance.now();
  let outcome = blockedBy(check, done);
  if (outcome === null) {
    try {
      outcome = await check.run(ctx);
    } catch (err) {
      outcome =
        err instanceof PendingError ? pending(err.pkg, err.message) : fail(errorMessage(err));
    }
  }
  const result: CheckResult = {
    ...outcome,
    id: check.id,
    layer: check.layer,
    title: check.title,
    owner: check.owner,
    dod: check.dod,
    ms: performance.now() - started,
  };
  log(
    `${statusLabel(result).toUpperCase().padEnd(12)} ${check.id} — ${result.detail.slice(0, 160)}`,
  );
  return result;
}

async function gitHead(dir: string): Promise<string> {
  const res = await run(['git', '-C', dir, 'log', '-1', '--format=%h %s']);
  return res.code === 0 ? res.stdout.trim() : 'unknown';
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = buildConfig(args);
  if (args.down) {
    await platformDown(cfg);
    await crobotDown(cfg);
    log('stack down');
    return 0;
  }
  const checks = selectChecks(args.only);
  const startedAt = new Date().toISOString();
  const ctx: Ctx = { cfg, facts: new Map() };
  const done = new Map<string, CheckResult>();
  let stackError: string | null = null;
  try {
    log(`platform: ${args.platformDir}`);
    ctx.facts.set('platform.status', await platformUp(cfg));
    log(`crobot: ${args.crobotDir}`);
    await crobotUp(cfg);
  } catch (err) {
    stackError = errorMessage(err);
    log(`STACK ERROR: ${stackError}`);
  }
  try {
    for (const check of checks) {
      done.set(check.id, await runCheck(check, ctx, done));
    }
  } finally {
    const summary = writeReport(
      cfg,
      {
        startedAt,
        finishedAt: new Date().toISOString(),
        platformDir: args.platformDir,
        platformCommit: await gitHead(args.platformDir),
        crobotDir: args.crobotDir,
        crobotCommit: await gitHead(args.crobotDir),
        strict: args.strict,
        stackError,
      },
      [...done.values()],
    );
    log(
      `${summary.pass} pass · ${summary.fail} fail · ${summary.pending} pending ${JSON.stringify(summary.pendingByPackage)} → scripts/e2e/cross/.artifacts/report.md`,
    );
    if (args.keepUp) {
      log(
        `--keep-up: collector ${cfg.collector.url}, crobot ${cfg.crobot.url}; stop with \`pnpm e2e:cross --down\``,
      );
    } else {
      await platformDown(cfg);
      await crobotDown(cfg);
    }
  }
  const results = [...done.values()];
  const failed =
    results.some((r) => r.status === 'fail') ||
    (args.strict && results.some((r) => r.status === 'pending'));
  return failed || stackError !== null ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    log(`FATAL: ${errorMessage(err)}`);
    process.exit(2);
  });
