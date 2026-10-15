/**
 * Layer `ui`: crobot's Playwright specs (`<crobot-dir>/tests/e2e/analytics-v2`)
 * in chromium against the live e2e app. Run once per harness run with this
 * repo's pinned @playwright/test (crobot has no Playwright dependency); each
 * check reads the result of the test whose title starts with `[<check id>]`.
 * A spec failing with `PENDING(<pkg>): …` is reported as pending-<pkg>.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { type CheckDef, type Ctx, type Outcome, fail, pass, pending } from '../lib/check.ts';
import { log } from '../lib/log.ts';
import { run } from '../lib/shell.ts';

interface PwResult {
  readonly status: string;
  readonly error?: { readonly message?: string };
}
interface PwSpec {
  readonly title: string;
  readonly tests: readonly { readonly results: readonly PwResult[] }[];
}
interface PwSuite {
  readonly specs?: readonly PwSpec[];
  readonly suites?: readonly PwSuite[];
}

type UiResults = Map<string, Outcome>;

function collect(suite: PwSuite, out: UiResults): void {
  for (const spec of suite.specs ?? []) {
    const id = /^\[([^\]]+)\]/.exec(spec.title)?.[1];
    const result = spec.tests[0]?.results.at(-1);
    if (id === undefined || result === undefined) continue;
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI colour codes
    const message = (result.error?.message ?? '').replace(/\u001b\[[0-9;]*m/g, '');
    const pend = /PENDING\(([^)]+)\):\s*(.*)/.exec(message);
    if (result.status === 'passed') out.set(id, pass(spec.title));
    else if (pend) out.set(id, pending(pend[1] ?? 'CD', pend[2] ?? ''));
    else
      out.set(id, fail(message.split('\n').slice(0, 6).join(' ').slice(0, 600) || result.status));
  }
  for (const child of suite.suites ?? []) collect(child, out);
}

/**
 * The spec files `import '@playwright/test'`, which Node resolves from the
 * crobot dir upwards. Runner and specs must be the SAME copy, so: use the copy
 * the crobot dir resolves to if there is one, else this repo's pinned copy
 * (apps/pixel) exposed to the specs through NODE_PATH.
 */
function resolvePlaywright(
  harnessRoot: string,
  crobotDir: string,
): { cli: string; nodePath: string } {
  const pixelModules = join(harnessRoot, 'apps', 'pixel', 'node_modules');
  try {
    const pkg = createRequire(join(crobotDir, 'noop.js')).resolve('@playwright/test/package.json');
    return { cli: join(dirname(pkg), 'cli.js'), nodePath: dirname(dirname(dirname(pkg))) };
  } catch {
    const cli = join(pixelModules, '@playwright', 'test', 'cli.js');
    if (!existsSync(cli))
      throw new Error(`Playwright not installed at ${cli} (pnpm install in ${harnessRoot})`);
    return { cli, nodePath: pixelModules };
  }
}

async function runPlaywright(ctx: Ctx): Promise<UiResults> {
  const cached = ctx.facts.get('ui.results') as UiResults | undefined;
  if (cached !== undefined) return cached;
  const { cfg } = ctx;
  const { cli, nodePath } = resolvePlaywright(cfg.harnessRoot, cfg.args.crobotDir);
  const config = join(cfg.args.crobotDir, 'playwright.config.ts');
  const results: UiResults = new Map();
  if (!existsSync(config)) {
    throw new Error(`${config} missing — crobot checkout lacks the X0 Playwright config`);
  }
  const jsonFile = join(cfg.artifactsDir, 'playwright.json');
  log('ui: running Playwright (chromium, 1 worker) against the crobot e2e app…');
  const res = await run(['node', cli, 'test', '-c', config, '--project', 'analytics-v2'], {
    cwd: cfg.args.crobotDir,
    env: {
      NODE_PATH: nodePath,
      E2E_CROBOT_URL: cfg.crobot.url,
      E2E_ARTIFACTS_DIR: cfg.artifactsDir,
      E2E_PW_JSON: jsonFile,
    },
    timeoutMs: 900_000,
  });
  if (!existsSync(jsonFile)) {
    throw new Error(
      `Playwright produced no report (exit ${res.code}): ${(res.stdout + res.stderr).slice(-600)}`,
    );
  }
  collect(JSON.parse(readFileSync(jsonFile, 'utf8')) as PwSuite, results);
  ctx.facts.set('ui.results', results);
  return results;
}

function uiCheck(
  id: string,
  title: string,
  owner: string,
  dod: readonly string[],
  needs: readonly string[],
): CheckDef {
  return {
    id,
    layer: 'ui',
    title,
    owner,
    dod,
    needs,
    async run(ctx) {
      const results = await runPlaywright(ctx);
      return results.get(id) ?? fail(`no Playwright test titled [${id}] ran`);
    },
  };
}

const DATA = ['sync.pull-rows'];
const EXTRAS = ['sync.extras'];

export const uiChecks: readonly CheckDef[] = [
  uiCheck(
    'ui.login',
    'Playwright: seeded user logs into the e2e app on :8188',
    'X0',
    ['X0 smoke', 'crobot §9 live'],
    ['infra.crobot-db'],
  ),
  uiCheck(
    'ui.f1-purchase',
    'UI: purchase goal 3 / 1 / 33.33 % vs 3 / 2 / 66.67 %',
    'CD',
    ['crobot §9 purchase', 'X1'],
    DATA,
  ),
  uiCheck(
    'ui.f1-aov-rpv',
    'UI: AOV €100.00 vs €62.50; RPV €33.33 vs €48.33',
    'CD',
    ['crobot §9 AOV/RPV', 'X1'],
    DATA,
  ),
  uiCheck('ui.f1-upsell', 'UI: upsell rate 0 % vs 50 %', 'CD', ['crobot §9 upsell', 'X1'], DATA),
  uiCheck(
    'ui.f1-funnel',
    'UI: cart abandonment 0 % vs 100 %; payment → purchase 100 % vs 200 %',
    'CD',
    ['crobot §9 funnel', 'X1'],
    DATA,
  ),
  uiCheck(
    'ui.f1-products',
    'UI: SKU-A units share 100 % vs 50 %',
    'CD',
    ['crobot §9 products', 'X1'],
    EXTRAS,
  ),
  uiCheck(
    'ui.f1-health',
    'UI: Data health shows the add_to_cart warning',
    'CD',
    ['crobot §9 health', 'X1'],
    EXTRAS,
  ),
  uiCheck(
    'ui.f3-label',
    'UI: F3 purchase goal Inconclusive at 95 %',
    'CD',
    ['crobot §9 F3 label', 'X1'],
    ['sync.f3-label'],
  ),
];
