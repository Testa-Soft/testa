/**
 * `count` stats model (admin v2: `count_mode: every` goals, mean events per
 * visitor) — pure module + `POST /api/v1/stats` over real HTTP.
 * Inputs per variation: n = visitors, sum = Σ count, sumSq = Σ count_sq_visitor.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Server } from 'bun';
import { config } from '../../config.ts';
import app from '../../index.ts';
import { computeStats } from '../index.ts';
import { MAX_KEY_LENGTH } from '../route.ts';

let server: Server;
let base: string;

beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: app.fetch });
  base = `http://localhost:${server.port}`;
});
afterAll(() => {
  server.stop(true);
});

const post = (body: unknown) =>
  fetch(`${base}/api/v1/stats`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Service-Token': config.serviceToken },
    body: JSON.stringify(body),
  });

/** Per-visitor counts → the summed row inputs crobot sends. */
function inputs(variation: number, counts: readonly number[]) {
  return {
    variation,
    n: counts.length,
    sum: counts.reduce((a, c) => a + c, 0),
    sumSq: counts.reduce((a, c) => a + c * c, 0),
  };
}

/** 1000 visitors: `zeros` with no event, the rest cycling through `pattern`. */
function visitors(zeros: number, pattern: readonly number[]): number[] {
  return Array.from({ length: 1000 }, (_, i) =>
    i < zeros ? 0 : (pattern[i % pattern.length] as number),
  );
}

const CONTROL = inputs(1, visitors(600, [1, 1, 2, 3])); // mean 0.7 events / visitor
const BETTER = inputs(2, visitors(500, [1, 2, 2, 3])); // mean 1.0

describe('count model (pure)', () => {
  const req = {
    control: 1,
    draws: 20_000,
    seedKey: '|page:contains:%2Fthanks|',
    variations: [CONTROL, BETTER],
  };

  it('lift ≈ ratio of mean events per visitor; clearly beats control', () => {
    const stats = computeStats({ ...req, model: 'count' });
    const b = stats.get(2);
    expect(b?.lift).toBeCloseTo(1.0 / 0.7 - 1, 1);
    expect(b?.chance_to_beat_control).toBeGreaterThan(0.99);
    expect(b?.insufficient_data).toBeUndefined();
  });

  it('posterior equals the normal mean model on the same inputs', () => {
    const count = computeStats({ ...req, model: 'count' });
    const normal = computeStats({ ...req, model: 'normal' });
    expect(count.get(2)).toEqual(normal.get(2) as NonNullable<ReturnType<typeof normal.get>>);
  });

  it('insufficient below 100 visitors or 10 events per variation', () => {
    const few = { variation: 2, n: 50, sum: 500, sumSq: 9000 };
    const rare = { variation: 2, n: 5000, sum: 9, sumSq: 9 };
    for (const v of [few, rare]) {
      const s = computeStats({ ...req, model: 'count', variations: [CONTROL, v] });
      expect(s.get(2)?.insufficient_data).toBe(true);
    }
    // normal only has the 10-observation floor: n = 50 is enough there.
    const normal = computeStats({ ...req, model: 'normal', variations: [CONTROL, few] });
    expect(normal.get(2)?.insufficient_data).toBeUndefined();
  });
});

describe('POST /api/v1/stats with model: count', () => {
  const key = `page:regex:${encodeURIComponent('^https://shop\\.example/thanks(\\?|$)')}`;

  it('200 with per-variation stats; deterministic', async () => {
    const body = { control: 1, metrics: [{ key, model: 'count', variations: [CONTROL, BETTER] }] };
    const [a, b] = await Promise.all([post(body), post(body)]);
    expect(a.status).toBe(200);
    const text = await a.text();
    expect(await b.text()).toBe(text);
    const json = JSON.parse(text) as { metrics: Record<string, Record<string, { lift?: number }>> };
    expect(json.metrics[key]?.['2']?.lift).toBeCloseTo(1.0 / 0.7 - 1, 1);
  });

  it('400 when sum / sumSq is missing or sum is negative', async () => {
    const cases = [
      [{ variation: 2, n: 1000, sumSq: 10 }, 'metrics[0].variations[1].sum'],
      [{ variation: 2, n: 1000, sum: 10 }, 'metrics[0].variations[1].sumSq'],
      [{ variation: 2, n: 1000, sum: -1, sumSq: 1 }, 'metrics[0].variations[1].sum'],
    ] as const;
    for (const [v, field] of cases) {
      const res = await post({
        control: 1,
        metrics: [{ key: 'goal:7', model: 'count', variations: [CONTROL, v] }],
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_body', field });
    }
  });

  it(`accepts keys up to ${MAX_KEY_LENGTH} chars, rejects longer`, async () => {
    const at = (len: number) =>
      post({
        control: 1,
        metrics: [{ key: 'k'.repeat(len), model: 'count', variations: [CONTROL, BETTER] }],
      });
    expect((await at(MAX_KEY_LENGTH)).status).toBe(200);
    const res = await at(MAX_KEY_LENGTH + 1);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_body', field: 'metrics[0].key' });
  });
});
