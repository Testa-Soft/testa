/**
 * `page:` metric keys against a real ClickHouse:
 *  - parity: the shared fixture table through the pixel's `urlMatchesGoal`
 *    (starts_with via the config builder's compiled regex) and through the
 *    ClickHouse predicate must agree on every URL × rule
 *  - RE2 vs JS: non-portable regexes → 400 `invalid_regex`; bad keys → 400
 *  - daily rows: per-visitor post-exposure page_view counts + count_sq_visitor
 *
 *   CLICKHOUSE_URL=http://localhost:8123 CLICKHOUSE_DATABASE=admin_v2_collector bun test page-keys
 */
import { beforeAll, describe, expect, it } from 'bun:test';
import type { DailyRow, MetricKey } from '@testa-platform/shared-types';
import { type UrlMatchesGoal, loadPixelUrlMatch } from '../../__test-utils__/pixel-url-match.ts';
import type { SyncApiError } from '../../analytics/errors.ts';
import { startsWithPattern } from '../../config/regex.ts';
import { computeDailyRows } from '../daily-rows.ts';
import { parseMetricKey } from '../metric-keys.ts';
import { assertPageRegexes, pageMatchSql, parsePageKey } from '../page-keys.ts';
import {
  database,
  live,
  prepareDatabase,
  randomExperimentId,
  randomProjectId,
  run,
} from './live.ts';
import { REJECTED_REGEXES, RULES, URLS, pageKey } from './page-match-fixtures.ts';
import { EXPECTED, FROM, SEED_KEYS, TO, seedPageEvents } from './page-seed.ts';

/** What the pixel does with a crobot goal of this rule (config builder → urlMatchesGoal). */
function pixelMatches(match: UrlMatchesGoal, url: string, rule: (typeof RULES)[number]): boolean {
  return rule.matchType === 'starts_with'
    ? match(url, startsWithPattern(rule.value), 'regex')
    : match(url, rule.value, rule.matchType);
}

function errorOf(fn: () => unknown): SyncApiError | undefined {
  try {
    fn();
  } catch (e) {
    return e as SyncApiError;
  }
  return undefined;
}

async function asyncErrorOf(p: Promise<unknown>): Promise<SyncApiError | undefined> {
  try {
    await p;
  } catch (e) {
    return e as SyncApiError;
  }
  return undefined;
}

describe('page key parsing (pure)', () => {
  it('round-trips encodeURIComponent and PHP rawurlencode-style values', () => {
    for (const rule of RULES) {
      expect(parseMetricKey(pageKey(rule))).toEqual({
        kind: 'page',
        key: pageKey(rule) as MetricKey,
        matchType: rule.matchType,
        value: rule.value,
      });
    }
    // rawurlencode also encodes ( ) ! * ' — decoded value is the same.
    expect(parsePageKey('page:exact:https%3A%2F%2Fshop.example%2Fcart%281%29')?.value).toBe(
      'https://shop.example/cart(1)',
    );
  });

  it('400 unknown_metric for a bad shape, length, encoding or empty value', () => {
    const tooLong = `page:contains:${'a'.repeat(1024 - 'page:contains:'.length + 1)}`;
    for (const key of [
      'page:prefix:%2Fx',
      'page:exact',
      'page::x',
      'page:contains:',
      'page:contains:%E0%A4%A',
      'page:not_contains:x',
      tooLong,
    ]) {
      expect(errorOf(() => parseMetricKey(key))?.toBody()).toEqual({
        error: 'unknown_metric',
        field: key,
      });
    }
    const atLimit = tooLong.slice(0, -1);
    expect(atLimit).toHaveLength(1024);
    expect(parseMetricKey(atLimit).kind).toBe('page');
  });

  it('400 invalid_regex for regexes JS rejects or reads unlike RE2', () => {
    for (const { value } of REJECTED_REGEXES.filter((r) => r.where === 'static')) {
      const key = `page:regex:${encodeURIComponent(value)}`;
      expect(errorOf(() => parseMetricKey(key))?.toBody()).toEqual({
        error: 'invalid_regex',
        field: key,
      });
    }
  });
});

describe.skipIf(!live)(`page keys (live ClickHouse, db=${database})`, () => {
  let urlMatchesGoal: UrlMatchesGoal;
  const projectId = randomProjectId();
  const experimentId = randomExperimentId();

  beforeAll(async () => {
    urlMatchesGoal = await loadPixelUrlMatch();
    await prepareDatabase();
    await seedPageEvents(projectId, experimentId);
  });

  it(`parity: pixel urlMatchesGoal ≡ ClickHouse on ${URLS.length} URLs × ${RULES.length} rules`, async () => {
    const preds = RULES.map((r, i) => `${pageMatchSql(r.matchType, `r${i}`)} AS m${i}`);
    const params = Object.fromEntries(RULES.map((r, i) => [`r${i}`, r.value]));
    const rows = await run<Record<string, number | string>>(
      `SELECT url, ${preds.join(', ')} FROM (SELECT arrayJoin({urls:Array(String)}) AS url)`,
      { ...params, urls: [...URLS] },
    );
    expect(rows).toHaveLength(URLS.length);
    const mismatches: string[] = [];
    let matches = 0;
    for (const r of rows) {
      const url = String(r.url);
      RULES.forEach((rule, i) => {
        const ch = Number(r[`m${i}`]) === 1;
        const px = pixelMatches(urlMatchesGoal, url, rule);
        if (px) matches++;
        if (ch !== px)
          mismatches.push(`${rule.matchType} ${rule.value} on ${url}: ch=${ch} px=${px}`);
      });
    }
    expect(mismatches).toEqual([]);
    expect(matches).toBeGreaterThan(40); // the table exercises both outcomes
  });

  it('every fixture regex compiles in RE2 (accepted keys never fail a run)', async () => {
    const keys = RULES.map((r) => parseMetricKey(pageKey(r)));
    await assertPageRegexes(run, keys);
  });

  it('RE2-only rejections → 400 invalid_regex (lookaround, [^], repeat > 1000, [\\b])', async () => {
    for (const { value } of REJECTED_REGEXES.filter((r) => r.where === 're2')) {
      const key = `page:regex:${encodeURIComponent(value)}`;
      const parsed = parseMetricKey(key); // portable as far as JS can tell
      const err = await asyncErrorOf(assertPageRegexes(run, [parsed]));
      expect(err?.toBody()).toEqual({ error: 'invalid_regex', field: key });
    }
  });

  it('computeDailyRows refuses a run with an RE2-invalid key (400, no rows)', async () => {
    const key = `page:regex:${encodeURIComponent('(?=x)')}` as MetricKey;
    const err = await asyncErrorOf(
      computeDailyRows(run, {
        projectId,
        experimentId,
        from: FROM,
        to: TO,
        reportCurrency: 'EUR',
        metrics: [key],
      }),
    );
    expect(err?.toBody()).toEqual({ error: 'invalid_regex', field: key });
  });

  it('daily rows: post-exposure, in-range, experiment-stamped page_views; count_sq_visitor = Σ n²', async () => {
    const result = await computeDailyRows(run, {
      projectId,
      experimentId,
      from: FROM,
      to: TO,
      reportCurrency: 'EUR',
      metrics: SEED_KEYS,
      variationOrder: [100, 101],
    });
    const rows = result.rows as DailyRow[];
    expect(rows).toHaveLength(2 * SEED_KEYS.length); // one date × 2 variations
    for (const r of rows) {
      expect(r.date).toBe(FROM);
      expect(r.visitors).toBe(3);
      expect([r.converted, r.count, r.count_sq_visitor]).toEqual(
        EXPECTED[r.variation_id]?.[r.metric_key] ?? [-1, -1, -1],
      );
      expect([r.sum, r.sum_sq, r.sum_sq_visitor]).toEqual([0, 0, 0]);
    }
    // The page key is echoed verbatim.
    expect(new Set(rows.map((r) => r.metric_key))).toEqual(new Set(SEED_KEYS));
  });
});
