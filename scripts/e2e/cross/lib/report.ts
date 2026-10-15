/** JSON + Markdown run report (`node_modules/.cache/e2e-cross/report.{json,md}`). */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type CheckResult, LAYERS, statusLabel } from './check.ts';
import type { HarnessConfig } from './config.ts';

export interface RunMeta {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly platformDir: string;
  readonly platformCommit: string;
  readonly crobotDir: string;
  readonly crobotCommit: string;
  readonly strict: boolean;
  readonly stackError: string | null;
}

export interface Summary {
  readonly pass: number;
  readonly fail: number;
  readonly pending: number;
  readonly pendingByPackage: Readonly<Record<string, number>>;
}

export function summarize(results: readonly CheckResult[]): Summary {
  const pendingByPackage: Record<string, number> = {};
  for (const r of results) {
    if (r.status === 'pending') {
      const key = r.pendingOn ?? '?';
      pendingByPackage[key] = (pendingByPackage[key] ?? 0) + 1;
    }
  }
  return {
    pass: results.filter((r) => r.status === 'pass').length,
    fail: results.filter((r) => r.status === 'fail').length,
    pending: results.filter((r) => r.status === 'pending').length,
    pendingByPackage,
  };
}

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 400);

function markdown(meta: RunMeta, results: readonly CheckResult[], summary: Summary): string {
  const lines = [
    '# Cross-repo live e2e report (X0)',
    '',
    `- Run: ${meta.startedAt} → ${meta.finishedAt}${meta.strict ? ' (strict)' : ''}`,
    `- testa-platform: \`${meta.platformDir}\` @ \`${meta.platformCommit}\``,
    `- crobot: \`${meta.crobotDir}\` @ \`${meta.crobotCommit}\``,
    `- **${summary.pass} pass · ${summary.fail} fail · ${summary.pending} pending** ${Object.entries(
      summary.pendingByPackage,
    )
      .map(([k, v]) => `(${k}: ${v})`)
      .join(' ')}`,
    ...(meta.stackError ? ['', `> Stack error: ${meta.stackError}`] : []),
  ];
  for (const layer of LAYERS) {
    const rows = results.filter((r) => r.layer === layer);
    if (rows.length === 0) continue;
    lines.push(
      '',
      `## ${layer}`,
      '',
      '| Check | Status | Owner | DoD | Detail | ms |',
      '|---|---|---|---|---|---|',
    );
    for (const r of rows) {
      lines.push(
        `| \`${r.id}\` ${cell(r.title)} | **${statusLabel(r)}** | ${r.owner} | ${cell(r.dod.join(', '))} | ${cell(r.detail)} | ${Math.round(r.ms)} |`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

export function writeReport(
  cfg: HarnessConfig,
  meta: RunMeta,
  results: readonly CheckResult[],
): Summary {
  const summary = summarize(results);
  writeFileSync(
    join(cfg.artifactsDir, 'report.json'),
    JSON.stringify({ meta, summary, results }, null, 2),
  );
  writeFileSync(join(cfg.artifactsDir, 'report.md'), markdown(meta, results, summary));
  return summary;
}
