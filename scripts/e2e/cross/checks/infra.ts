/** Layer `infra`: every live process of both systems is up and healthy. */

import { type CheckDef, Diff, fail, pass, pending } from '../lib/check.ts';
import { chQuery, chTableExists } from '../lib/clickhouse.ts';
import { http } from '../lib/http.ts';
import { redisCli } from '../lib/redis.ts';
import { PidFile, isAlive, run } from '../lib/shell.ts';
import { e2eArtisan } from '../stack/crobot.ts';
import type { PlatformStatus } from '../stack/platform.ts';

const platformStatus = (facts: Map<string, unknown>): PlatformStatus | undefined =>
  facts.get('platform.status') as PlatformStatus | undefined;

async function containerRunning(name: string): Promise<boolean> {
  const res = await run(['docker', 'inspect', '-f', '{{.State.Running}}', name]);
  return res.stdout.trim() === 'true';
}

export const infraChecks: readonly CheckDef[] = [
  {
    id: 'infra.clickhouse',
    layer: 'infra',
    title: 'ClickHouse database prd006_x0 exists and is migrated',
    owner: 'X0',
    dod: ['X0 infra'],
    async run({ cfg }) {
      const migrations = await chQuery<{ n: string }>(
        cfg.clickhouse,
        'SELECT count() AS n FROM _migrations',
      );
      const d = new Diff()
        .truthy('events table', await chTableExists(cfg.clickhouse, 'events'))
        .truthy('events_buffer table', await chTableExists(cfg.clickhouse, 'events_buffer'))
        .truthy('migrations applied', Number(migrations[0]?.n ?? 0) > 0);
      return d.outcome(`${migrations[0]?.n} migrations applied in ${cfg.clickhouse.database}`);
    },
  },
  {
    id: 'infra.redis',
    layer: 'infra',
    title: 'Redis tp-redis DB index reachable',
    owner: 'X0',
    dod: ['X0 infra'],
    async run({ cfg }) {
      const pong = await redisCli(cfg.redis, ['PING']);
      return pong === 'PONG' ? pass(`db ${cfg.redis.db} PONG`) : fail(`PING returned ${pong}`);
    },
  },
  {
    id: 'infra.collector',
    layer: 'infra',
    title: 'Collector API on :8091 healthy (Redis + ClickHouse)',
    owner: 'X0',
    dod: ['X0 infra'],
    async run({ cfg }) {
      const res = await http({ url: `${cfg.collector.url}/_internal/health` });
      return res.status === 200 ? pass(res.text) : fail(`health ${res.status}: ${res.text}`);
    },
  },
  {
    id: 'infra.consumer',
    layer: 'infra',
    title: 'Collector consumer process running',
    owner: 'X0',
    dod: ['X0 infra'],
    async run({ cfg }) {
      const pid = new PidFile(cfg.artifactsDir).read().consumer;
      return pid !== undefined && isAlive(pid)
        ? pass(`pid ${pid}`)
        : fail('consumer not running (see node_modules/.cache/e2e-cross/logs/consumer.log)');
    },
  },
  {
    id: 'infra.modeler',
    layer: 'infra',
    title: 'Modeler process running (scheduler + workers)',
    owner: 'P4',
    dod: ['PRD-006 §3.2', 'V16'],
    async run({ cfg, facts }) {
      const status = platformStatus(facts);
      const pid = new PidFile(cfg.artifactsDir).read().modeler;
      if (status?.modeler === 'running' && pid !== undefined && isAlive(pid))
        return pass(`pid ${pid}`);
      return pending('P4', `modeler ${status?.modeler ?? 'unknown'}: ${status?.modelerNote ?? ''}`);
    },
  },
  {
    id: 'infra.edge',
    layer: 'infra',
    title: 'Edge worker (wrangler dev) on :8792',
    owner: 'X0',
    dod: ['X0 infra'],
    async run({ facts }) {
      const status = platformStatus(facts);
      if (status?.edge === 'running') return pass('GET /health 200');
      if (status?.edge === 'disabled') return pending('X0', 'edge disabled with --no-edge');
      return fail(
        `edge ${status?.edge ?? 'unknown'}: ${status?.edgeNote ?? ''} (see node_modules/.cache/e2e-cross/logs/edge.log)`,
      );
    },
  },
  {
    id: 'infra.crobot-web',
    layer: 'infra',
    title: 'crobot e2e app serves /login on :8188',
    owner: 'X0',
    dod: ['X0 infra'],
    async run({ cfg }) {
      const res = await http({ url: `${cfg.crobot.url}/login`, headers: { accept: 'text/html' } });
      const d = new Diff()
        .eq('status', 200, res.status)
        .truthy(
          'login form',
          res.text.includes('name="email"') && res.text.includes('name="password"'),
        );
      return d.outcome('login form served');
    },
  },
  {
    id: 'infra.crobot-db',
    layer: 'infra',
    title:
      'crobot app uses crobot_e2e, migrated + seeded (project 42, experiments 1717/1802/1903/1900)',
    owner: 'X0',
    dod: ['X0 infra'],
    async run({ cfg, facts }) {
      const info = await e2eArtisan(cfg, 'info');
      if (!info.ok) return fail(`e2e:analytics info failed: ${info.error}`);
      facts.set('crobot.info', info);
      const seed = info.seed as { experiments?: Record<string, number> } | undefined;
      const d = new Diff()
        .eq('database', cfg.crobot.database, info.database)
        .eq(
          'seeded experiments (identifier → id)',
          { 1717: 5001, 1802: 5002, 1900: 5004, 1903: 5003 },
          seed?.experiments,
        );
      return d.outcome('crobot_e2e seeded', seed);
    },
  },
  {
    id: 'infra.crobot-worker',
    layer: 'infra',
    title: 'crobot e2e queue worker running',
    owner: 'X0',
    dod: ['X0 infra'],
    async run({ cfg }) {
      return (await containerRunning(cfg.crobot.workerContainer))
        ? pass(cfg.crobot.workerContainer)
        : fail(`${cfg.crobot.workerContainer} not running`);
    },
  },
  {
    id: 'infra.crobot-env',
    layer: 'infra',
    title: 'crobot e2e env: live mode, collector :8091, service token + webhook secret wired',
    owner: 'CB',
    dod: ['crobot §9 live stack', 'X1'],
    needs: ['infra.crobot-db'],
    async run({ cfg, facts }) {
      const info = facts.get('crobot.info') as { config?: Record<string, unknown> } | undefined;
      const c = info?.config ?? {};
      if (c.testa_config_url !== cfg.crobot.collectorUrlFromCrobot) {
        return fail(
          'services.testa_config.url not pointed at the harness collector',
          cfg.crobot.collectorUrlFromCrobot,
          c.testa_config_url,
        );
      }
      if (c.testa_analytics_present !== true)
        return pending('CB', "config('services.testa_analytics') missing (C1)");
      const d = new Diff()
        .eq('mock', false, c.mock === false || c.mock === 'false' || c.mock === 0 ? false : c.mock)
        .eq('url', cfg.crobot.collectorUrlFromCrobot, c.url)
        .truthy('token set', c.token_set === true)
        .truthy('webhook secret set', c.webhook_secret_set === true);
      return d.outcome('services.testa_analytics wired to the live collector', c);
    },
  },
];
