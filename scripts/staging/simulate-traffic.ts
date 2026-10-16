/**
 * Feed simulated traffic for one A/B test into the STAGING collector.
 *
 *   set -a; . ~/.config/testa-staging/secrets.env; set +a
 *   bun scripts/staging/simulate-traffic.ts --project <crobot project uuid> --experiment <identifier>
 *
 * Options:
 *   --visitors <n>     visitors per variation (default 5000)
 *   --days <n>         spread exposures over the last n days (default 14)
 *   --lift <id=m,…>    funnel-entry multiplier per variation (default 1.10 for every non-control)
 *   --seed <n>         generator seed (default: current minute, so reruns add new visitors)
 *   --domain <host>    host in page URLs (default testa-web-native-landing-git-staging-testa-8da30fbe.vercel.app)
 *   --collector <url>  default https://testa-collector-staging.fly.dev
 *   --dry-run          generate and print the summary, send nothing
 *
 * The experiment and its variations are read from the live config the
 * collector serves for the project (crobot pushes it on save), so the ids
 * always match crobot. Only v2 experiments are accepted.
 */

import { parseArgs } from 'node:util';
import { ingestEvents } from '../e2e/cross/shared/ingest-client.ts';
import { simToWire } from '../e2e/prd006/ingest.ts';
import { generateTraffic } from './traffic-generator.ts';

const DEFAULT_COLLECTOR = 'https://testa-collector-staging.fly.dev';
const PRODUCTION_HOSTS = ['config.testa-soft.tech', 'testa-collector.fly.dev'];
const BATCH = 500;

interface ServedExperiment {
  readonly experiment_id: number;
  readonly platform_version?: string;
  readonly variations: readonly { readonly variation_id: number }[];
}

interface ServedConfig {
  readonly project_id: number;
  readonly experiments: readonly ServedExperiment[];
}

function fail(message: string): never {
  console.error(`simulate-traffic: ${message}`);
  process.exit(1);
}

function positiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) fail(`--${name} must be a positive integer, got ${raw}`);
  return n;
}

function parseLift(raw: string | undefined, variations: readonly number[]): Record<number, number> {
  const [, ...treatments] = variations;
  if (raw === undefined) return Object.fromEntries(treatments.map((v) => [v, 1.1]));
  const lift: Record<number, number> = {};
  for (const part of raw.split(',')) {
    const [id, m] = part.split('=');
    if (id === undefined || m === undefined || !Number.isFinite(Number(id)) || !(Number(m) > 0))
      fail(`--lift expects id=multiplier pairs, e.g. 1=1.15,2=0.95; got "${part}"`);
    lift[Number(id)] = Number(m);
  }
  return lift;
}

async function fetchConfig(collector: string, project: string): Promise<ServedConfig> {
  const res = await fetch(`${collector}/api/v1/config/${encodeURIComponent(project)}`);
  if (res.status === 404)
    fail(
      `no config for project ${project} on ${collector}; save the project in crobot staging first`,
    );
  if (!res.ok) fail(`config fetch returned HTTP ${res.status}`);
  const body = (await res.json()) as Partial<ServedConfig>;
  if (typeof body.project_id !== 'number' || !Array.isArray(body.experiments))
    fail('config response has no project_id / experiments');
  return body as ServedConfig;
}

function findExperiment(config: ServedConfig, identifier: number): number[] {
  const exp = config.experiments.find((e) => e.experiment_id === identifier);
  if (exp === undefined) {
    const known = config.experiments.map((e) => e.experiment_id).join(', ') || 'none';
    fail(
      `experiment ${identifier} is not in the served config (experiments: ${known}); is it active?`,
    );
  }
  if (exp.platform_version !== 'v2')
    fail(
      `experiment ${identifier} is ${exp.platform_version ?? 'v1'}; only v2 experiments are analysed`,
    );
  // Control = lowest identifier (crobot + platform rule).
  return exp.variations.map((v) => v.variation_id).sort((a, b) => a - b);
}

function summarize(
  events: readonly { event_name: string; exp_var_ids: readonly number[] }[],
): void {
  const counts = new Map<string, number>();
  for (const e of events) {
    const key = `${e.exp_var_ids[0]}\t${e.event_name}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const rows = [...counts].sort(([a], [b]) => a.localeCompare(b));
  console.log('variation\tevent\tcount');
  for (const [key, n] of rows) console.log(`${key}\t${n}`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      project: { type: 'string' },
      experiment: { type: 'string' },
      visitors: { type: 'string' },
      days: { type: 'string' },
      lift: { type: 'string' },
      seed: { type: 'string' },
      domain: { type: 'string' },
      collector: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  const project = values.project ?? fail('--project <crobot project uuid> is required');
  const experiment = positiveInt(values.experiment, Number.NaN, 'experiment');
  if (Number.isNaN(experiment)) fail('--experiment <identifier> is required');
  const collector = (values.collector ?? DEFAULT_COLLECTOR).replace(/\/$/, '');
  if (PRODUCTION_HOSTS.some((h) => collector.includes(h)))
    fail(`${collector} is production; this script only feeds staging`);

  const config = await fetchConfig(collector, project);
  const variations = findExperiment(config, experiment);
  const nowMs = Date.now();
  const seed = positiveInt(values.seed, Math.floor(nowMs / 60_000) % 1_000_000_000, 'seed');
  const sim = generateTraffic({
    projectId: config.project_id,
    experimentId: experiment,
    variations,
    visitorsPerVariation: positiveInt(values.visitors, 5000, 'visitors'),
    days: positiveInt(values.days, 14, 'days'),
    nowMs,
    lift: parseLift(values.lift, variations),
    seed,
    domain: values.domain ?? 'testa-web-native-landing-git-staging-testa-8da30fbe.vercel.app',
  });
  console.log(
    `project ${config.project_id} (${project}) · experiment ${experiment} · variations ${variations.join(', ')} (control ${variations[0]}) · seed ${seed}`,
  );
  summarize(sim.events);
  if (values['dry-run']) return;

  const secret = process.env.INGEST_SHARED_SECRET;
  if (!secret) fail('INGEST_SHARED_SECRET is not set (source ~/.config/testa-staging/secrets.env)');
  const wire = simToWire(sim);
  const started = performance.now();
  const res = await ingestEvents(collector, secret, wire, BATCH);
  const s = ((performance.now() - started) / 1000).toFixed(1);
  console.log(
    `sent ${wire.length} events in ${res.batches} batches (${s} s); accepted ${res.accepted}`,
  );
  console.log(
    'Next: the modeler picks the experiment up within 5 min; then crobot staging syncs (cron every 15 min, or "Sync now" on the results page).',
  );
}

main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
