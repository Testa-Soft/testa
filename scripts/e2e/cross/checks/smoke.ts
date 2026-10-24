/**
 * Layer `smoke`: the live boundary works TODAY with what is already built —
 * real ingest into prd006_x0, the edge path, container ↔ host networking, and
 * crobot's real config publish landing in the live collector.
 */

import { type CheckDef, Diff, fail, pass } from '../lib/check.ts';
import { chQuery } from '../lib/clickhouse.ts';
import { http, field } from '../lib/http.ts';
import { run } from '../lib/shell.ts';
import type { WireEvent } from '../shared/f1-wire.ts';
import { uuidFor } from '../shared/ids.ts';
import { ingestEvents, waitForEventRows } from '../shared/ingest-client.ts';
import { e2eArtisan } from '../stack/crobot.ts';

/** Smoke rows live in their own project so they never touch fixture counts. */
const SMOKE_PROJECT = 990042;

function smokeEvent(name: string, runId: string): WireEvent {
  const now = Date.now();
  return {
    event_id: uuidFor(`${name}|${runId}`),
    event_name: name,
    client_ts: now,
    server_ts: now,
    project_id: SMOKE_PROJECT,
    visitor_id: `smoke-${runId}`,
    session_id: `smoke-s-${runId}`,
    url: 'https://shop.example/smoke',
    consent_state: 'granted',
    tracker_version: 'x0-smoke',
    viewport_w: 1280,
    viewport_h: 800,
    country: 'LT',
    region: '',
    region_subdivision: '',
    city: '',
    device_type: 'desktop',
    browser: 'Chrome',
    os: 'macOS',
    is_bot: 0,
  };
}

interface PublishedExperiment {
  readonly experiment_id?: number;
  readonly platform_version?: string;
  readonly variations?: readonly { readonly variation_id?: number }[];
}

export const smokeChecks: readonly CheckDef[] = [
  {
    id: 'smoke.ingest-roundtrip',
    layer: 'smoke',
    title: 'HMAC POST /_ingest → Redis → consumer → ClickHouse prd006_x0 (read back)',
    owner: 'X0',
    dod: ['X0 smoke', 'PRD-001 pipeline'],
    needs: ['infra.collector', 'infra.consumer'],
    async run({ cfg }) {
      const runId = `${Date.now()}`;
      const ev = smokeEvent('x0_smoke', runId);
      const res = await ingestEvents(cfg.collector.url, cfg.secrets.ingest, [ev]);
      if (res.accepted !== 1) return fail('ingest did not accept the event', 1, res.accepted);
      await waitForEventRows(cfg.clickhouse, `event_id = '${ev.event_id}'`, 1, 60_000);
      return pass(`event ${ev.event_id} read back from ${cfg.clickhouse.database}.events`);
    },
  },
  {
    id: 'smoke.edge-roundtrip',
    layer: 'smoke',
    title: 'Pixel-shaped POST /track on wrangler dev → DO batch → collector → ClickHouse',
    owner: 'X0',
    dod: ['X0 smoke', 'PRD-006 §1.9 edge'],
    needs: ['infra.edge', 'smoke.ingest-roundtrip'],
    async run({ cfg }) {
      const runId = `${Date.now()}`;
      const {
        server_ts: _s,
        region: _r,
        region_subdivision: _rs,
        city: _c,
        device_type: _d,
        browser: _b,
        os: _o,
        is_bot: _i,
        country: _co,
        ...pixel
      } = smokeEvent('x0_edge_smoke', runId);
      const res = await http({
        url: `${cfg.edge.url}/track`,
        body: [pixel],
        headers: {
          'user-agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 Chrome/129.0 Safari/537.36',
        },
      });
      if (res.status !== 204) return fail(`/track returned ${res.status}`, 204, res.status);
      await waitForEventRows(cfg.clickhouse, `event_id = '${pixel.event_id}'`, 1, 60_000);
      const rows = await chQuery<{ device_type: string; is_bot: number }>(
        cfg.clickhouse,
        `SELECT device_type, is_bot FROM events WHERE event_id = '${pixel.event_id}'`,
      );
      return pass(`edge-enriched row landed (device_type=${rows[0]?.device_type})`);
    },
  },
  {
    id: 'smoke.crobot-reaches-collector',
    layer: 'smoke',
    title: 'crobot container → host.docker.internal:8091 (TESTA_COLLECTOR_API_URL) reachable',
    owner: 'X0',
    dod: ['X0 smoke', 'crobot §9 live stack'],
    needs: ['infra.collector', 'infra.crobot-web'],
    async run({ cfg }) {
      const res = await run([
        'docker',
        'exec',
        cfg.crobot.webContainer,
        'php',
        '-r',
        `echo @file_get_contents('${cfg.crobot.collectorUrlFromCrobot}/_internal/live') ?: 'UNREACHABLE';`,
      ]);
      return res.stdout.includes('"ok":true')
        ? pass(res.stdout.trim())
        : fail(`from ${cfg.crobot.webContainer}: ${res.stdout}${res.stderr}`);
    },
  },
  {
    id: 'smoke.config-publish',
    layer: 'smoke',
    title:
      "crobot's real config publish (GenerateProjectScriptHandler) → POST /api/v1/config/{uuid} on :8091",
    owner: 'X0',
    dod: ['X0 smoke', 'decision_config_api_single_source'],
    needs: ['infra.crobot-db', 'infra.collector'],
    async run({ cfg, facts }) {
      const published = await e2eArtisan(cfg, 'publish-config');
      if (!published.ok) return fail(`e2e:analytics publish-config: ${published.error}`);
      const res = await http({ url: `${cfg.collector.url}/api/v1/config/${cfg.ids.projectUuid}` });
      if (res.status !== 200) {
        return fail(
          `GET /api/v1/config/${cfg.ids.projectUuid} → ${res.status} (publish failed; see crobot storage/logs/laravel.log TESTA_CONFIG_PUBLISH_*)`,
        );
      }
      facts.set('platform.config', res.json);
      const experiments = (field(res.json, 'experiments') ?? []) as readonly PublishedExperiment[];
      const byId = new Map(experiments.map((e) => [e.experiment_id, e]));
      const vars = (id: number): number[] =>
        (byId.get(id)?.variations ?? []).map((v) => v.variation_id ?? -1).sort();
      const d = new Diff()
        .eq('project_id', cfg.ids.projectId, field(res.json, 'project_id'))
        .eq('1717 variations', [100, 101], vars(1717))
        .eq('1802 variations', [200, 201], vars(1802))
        .eq('1903 variations', [100, 101, 102], vars(1903))
        .truthy('1900 present', byId.has(1900));
      return d.outcome(
        `config for project ${cfg.ids.projectId} stored under ${cfg.ids.projectUuid}`,
        {
          experiments: experiments.map((e) => ({
            id: e.experiment_id,
            platform_version: e.platform_version,
          })),
        },
      );
    },
  },
];
