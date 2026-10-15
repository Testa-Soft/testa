/**
 * `POST /api/v1/stats` over real HTTP (task 5.11, 006-validation V7): the full
 * app on a random port, the service token, F3 goldens through the endpoint,
 * byte-identical repeats, validation errors.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Server } from 'bun';
import { config } from '../../config.ts';
import app from '../../index.ts';
import { MAX_BODY_BYTES } from '../route.ts';

let server: Server;
let base: string;

beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: app.fetch });
  base = `http://localhost:${server.port}`;
});
afterAll(() => {
  server.stop(true);
});

const post = (body: unknown, token: string | null = config.serviceToken) =>
  fetch(`${base}/api/v1/stats`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { 'X-Service-Token': token }),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const F3 = {
  control: 100,
  metrics: [
    {
      key: 'purchase',
      model: 'beta',
      variations: [
        { variation: 100, n: 4737, x: 115 },
        { variation: 101, n: 4790, x: 137 },
        { variation: 102, n: 4702, x: 109 },
      ],
    },
  ],
};

type Body = { metrics: Record<string, Record<string, Record<string, unknown>>> };

describe('auth', () => {
  it('401 without or with a wrong token', async () => {
    for (const token of [null, 'nope']) {
      const res = await post(F3, token);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    }
  });
});

describe('F3 golden through the endpoint (V7)', () => {
  it('variation 101: chance to beat ∈ [0.902, 0.912], best ∈ [0.871, 0.881]', async () => {
    const res = await post(F3);
    expect(res.status).toBe(200);
    const v = ((await res.json()) as Body).metrics.purchase?.['101'];
    expect(v?.chance_to_beat_control).toBeGreaterThanOrEqual(0.902);
    expect(v?.chance_to_beat_control).toBeLessThanOrEqual(0.912);
    expect(v?.chance_to_be_best).toBeGreaterThanOrEqual(0.871);
    expect(v?.chance_to_be_best).toBeLessThanOrEqual(0.881);
    expect(Object.keys(v ?? {}).sort()).toEqual([
      'chance_to_be_best',
      'chance_to_beat_control',
      'expected_loss',
      'lift',
      'lift_ci',
    ]);
  });

  it('control carries chance_to_be_best only', async () => {
    const body = (await (await post(F3)).json()) as Body;
    expect(Object.keys(body.metrics.purchase?.['100'] ?? {})).toEqual(['chance_to_be_best']);
  });

  it('same body twice → byte-identical response', async () => {
    const a = await (await post(F3)).text();
    const b = await (await post(F3)).text();
    expect(a).toBe(b);
  });

  it('control: 101 flips the reference', async () => {
    const body = (await (await post({ ...F3, control: 101 })).json()) as Body;
    expect(Object.keys(body.metrics.purchase?.['101'] ?? {})).toEqual(['chance_to_be_best']);
    expect(body.metrics.purchase?.['100']?.chance_to_beat_control).toBeLessThan(0.1);
  });

  it('< 100 visitors → insufficient_data', async () => {
    const body = (await (
      await post({
        control: 100,
        metrics: [
          {
            key: 'purchase',
            model: 'beta',
            variations: [
              { variation: 100, n: 4737, x: 115 },
              { variation: 101, n: 99, x: 12 },
            ],
          },
        ],
      })
    ).json()) as Body;
    expect(body.metrics.purchase?.['101']?.insufficient_data).toBe(true);
    expect(body.metrics.purchase?.['100']?.insufficient_data).toBeUndefined();
  });
});

describe('options', () => {
  const aov = {
    key: 'aov',
    model: 'normal',
    variations: [
      { variation: 100, n: 107, sum: 9855.6, sumSq: 1_265_432.1 },
      { variation: 101, n: 120, sum: 8839.2, sumSq: 902_211.7 },
    ],
  };

  it('normal metrics, direction lower and confidence in one call', async () => {
    const res = await post({
      control: 100,
      confidence: 0.9,
      metrics: [aov, { ...F3.metrics[0], key: 'abandon', direction: 'lower' }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.metrics.aov?.['101']?.lift).toBeLessThan(0);
    expect(body.metrics.abandon?.['101']?.chance_to_beat_control).toBeLessThan(0.1);
  });

  it('segment: true uses 10k draws (differs from the 100k result, still deterministic)', async () => {
    const full = await (await post(F3)).text();
    const seg = await (await post({ ...F3, segment: true })).text();
    const segAgain = await (await post({ ...F3, segment: true })).text();
    expect(seg).not.toBe(full);
    expect(seg).toBe(segAgain);
    const tenK = await (await post({ ...F3, draws: 10_000 })).text();
    expect(tenK).toBe(seg);
  });
});

describe('validation errors (400)', () => {
  const metric = F3.metrics[0] as (typeof F3.metrics)[number];
  const cases: [string, unknown, unknown][] = [
    ['malformed JSON', '{"control":', { error: 'invalid_body' }],
    ['missing metrics', { control: 100 }, { error: 'invalid_body', field: 'metrics' }],
    ['empty metrics', { control: 100, metrics: [] }, { error: 'invalid_body', field: 'metrics' }],
    [
      'unknown model',
      { control: 100, metrics: [{ ...metric, model: 'lognormal' }] },
      { error: 'invalid_body', field: 'metrics[0].model' },
    ],
    [
      'confidence out of range',
      { ...F3, confidence: 1 },
      { error: 'invalid_body', field: 'confidence' },
    ],
    ['draws above 100k', { ...F3, draws: 100_001 }, { error: 'invalid_body', field: 'draws' }],
    [
      'control not in variations',
      { ...F3, control: 7 },
      { error: 'invalid_body', field: 'control' },
    ],
    [
      'duplicate metric key',
      { control: 100, metrics: [metric, metric] },
      { error: 'invalid_body', field: 'metrics[1].key' },
    ],
    [
      'duplicate variation id',
      {
        control: 100,
        metrics: [{ ...metric, variations: [metric.variations[0], metric.variations[0]] }],
      },
      { error: 'invalid_body', field: 'metrics[0].variations' },
    ],
    [
      'beta without x',
      {
        control: 100,
        metrics: [{ ...metric, variations: [metric.variations[0], { variation: 101, n: 10 }] }],
      },
      { error: 'invalid_body', field: 'metrics[0].variations[1].x' },
    ],
    [
      'beta x > n',
      {
        control: 100,
        metrics: [
          { ...metric, variations: [metric.variations[0], { variation: 101, n: 10, x: 11 }] },
        ],
      },
      { error: 'invalid_body', field: 'metrics[0].variations[1].x' },
    ],
    [
      'normal without sumSq',
      {
        control: 1,
        metrics: [
          {
            key: 'aov',
            model: 'normal',
            variations: [
              { variation: 1, n: 10, sum: 5, sumSq: 9 },
              { variation: 2, n: 10, sum: 5 },
            ],
          },
        ],
      },
      { error: 'invalid_body', field: 'metrics[0].variations[1].sumSq' },
    ],
    [
      'negative n',
      {
        control: 100,
        metrics: [
          { ...metric, variations: [metric.variations[0], { variation: 101, n: -1, x: 0 }] },
        ],
      },
      { error: 'invalid_body', field: 'metrics[0].variations[1].n' },
    ],
  ];

  it.each(cases)('%s', async (_name, body, expected) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(expected);
  });

  it('51 metrics → too_large', async () => {
    const metrics = Array.from({ length: 51 }, (_, i) => ({ ...metric, key: `m${i}` }));
    const res = await post({ control: 100, metrics });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'too_large', field: 'metrics' });
  });

  it('11 variations → too_large', async () => {
    const variations = Array.from({ length: 11 }, (_, i) => ({
      variation: 100 + i,
      n: 500,
      x: 20,
    }));
    const res = await post({ control: 100, metrics: [{ ...metric, variations }] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'too_large', field: 'metrics[0].variations' });
  });

  it('50 metrics × 10 variations is accepted (segment draws)', async () => {
    const variations = Array.from({ length: 10 }, (_, i) => ({
      variation: 100 + i,
      n: 500,
      x: 20,
    }));
    const metrics = Array.from({ length: 50 }, (_, i) => ({ ...metric, key: `m${i}`, variations }));
    const res = await post({ control: 100, segment: true, metrics });
    expect(res.status).toBe(200);
    expect(Object.keys(((await res.json()) as Body).metrics)).toHaveLength(50);
  });

  it('oversized body → too_large', async () => {
    const res = await post(`{"pad":"${'x'.repeat(MAX_BODY_BYTES)}"}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'too_large' });
  });
});
