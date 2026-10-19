import type { QueryRunner } from '../analytics/attribution.ts';
/**
 * `page:<match_type>:<value>` metric keys (admin v2 CONTRACT "Metric keys"):
 * per visitor, the attributed `page_view` events whose `url` matches. The
 * value is `encodeURIComponent(action)` (PHP `rawurlencode`); the key string is
 * echoed verbatim as the row's `metric_key`, so either encoder works.
 *
 * URL semantics equal the pixel's `urlMatchesGoal`
 * (packages/dom/src/goals/controller.ts), proven by a shared fixture table
 * against both (page-keys parity test):
 *   exact        url === value                 → url = v
 *   contains     url.includes(value)           → position(url, v) > 0
 *   starts_with  regex ^ + escaped value       → startsWith(url, v)
 *   regex        new RegExp(value).test(url)   → match(url, v)   (RE2)
 *
 * RE2 vs JS: a regex is accepted only when both engines read it the same way.
 * `parsePageKey` rejects what JS rejects and JS-only escapes RE2 reads
 * differently (`\p{L}`, `\A`, `\x{41}`, `\cA`, `A`, backrefs…);
 * `assertPageRegexes` then asks ClickHouse to compile the rest (lookaround,
 * `[^]`, repeats > 1000…). Either failure → 400 `invalid_regex`, field = key.
 */
import { SyncApiError } from '../analytics/errors.ts';

export const PAGE_MATCH_TYPES = ['exact', 'contains', 'starts_with', 'regex'] as const;
export type PageMatchType = (typeof PAGE_MATCH_TYPES)[number];

export const MAX_METRIC_KEY_LENGTH = 1024;
const PREFIX = 'page:';

export interface PageKeyParts {
  matchType: PageMatchType;
  /** Decoded `action`. */
  value: string;
}

/** CH error code for an RE2 compile failure (`CANNOT_COMPILE_REGEXP`). */
const CANNOT_COMPILE_REGEXP = '427';

/** Escapes JS and RE2 both read identically (besides escaped punctuation). */
const SHARED_ESCAPES = new Set(['d', 'D', 'w', 'W', 's', 'S', 'b', 'B', 'n', 'r', 't', 'f', 'v']);
const HEX2 = /^[0-9A-Fa-f]{2}$/;

const isPageMatchType = (s: string): s is PageMatchType =>
  (PAGE_MATCH_TYPES as readonly string[]).includes(s);

/**
 * First escape in `pattern` that JS (non-unicode mode) and RE2 read
 * differently, or undefined. JS treats unknown `\<letter>` as the letter;
 * RE2 rejects it or gives it a meaning (`\A`, `\z`, `\pL`, `\Q…\E`, `\C`).
 */
export function nonPortableEscape(pattern: string): string | undefined {
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] !== '\\') continue;
    const next = pattern[i + 1] ?? '';
    i++;
    if (SHARED_ESCAPES.has(next)) continue;
    if (next === '0' && !/[0-9]/.test(pattern[i + 1] ?? '')) continue; // NUL, not octal
    if (next === 'x' && HEX2.test(pattern.slice(i + 1, i + 3))) continue;
    if (next !== '' && !/[A-Za-z0-9]/.test(next)) continue; // escaped punctuation: literal in both
    return `\\${next}`;
  }
  return undefined;
}

/** JS `RegExp` (what the pixel runs) must compile it and RE2 must read it the same. */
function assertPortableRegex(value: string, key: string): void {
  try {
    new RegExp(value);
  } catch {
    throw new SyncApiError('invalid_regex', 400, key);
  }
  if (nonPortableEscape(value) !== undefined) throw new SyncApiError('invalid_regex', 400, key);
}

/**
 * Parse a `page:` key; `null` when `raw` isn't one. Throws 400
 * `unknown_metric` (bad shape / length / encoding / empty value) or
 * `invalid_regex` (field = the key).
 */
export function parsePageKey(raw: string): PageKeyParts | null {
  if (!raw.startsWith(PREFIX)) return null;
  const bad = new SyncApiError('unknown_metric', 400, raw);
  if (raw.length > MAX_METRIC_KEY_LENGTH) throw bad;
  const rest = raw.slice(PREFIX.length);
  const sep = rest.indexOf(':');
  const matchType = sep < 0 ? '' : rest.slice(0, sep);
  if (!isPageMatchType(matchType)) throw bad;
  let value: string;
  try {
    value = decodeURIComponent(rest.slice(sep + 1));
  } catch {
    throw bad;
  }
  if (value.length === 0) throw bad;
  if (matchType === 'regex') assertPortableRegex(value, raw);
  return { matchType, value };
}

/** ClickHouse predicate on `url` for one page key; `param` names a String query param. */
export function pageMatchSql(matchType: PageMatchType, param: string): string {
  const v = `{${param}:String}`;
  switch (matchType) {
    case 'exact':
      return `url = ${v}`;
    case 'contains':
      return `position(url, ${v}) > 0`;
    case 'starts_with':
      return `startsWith(url, ${v})`;
    case 'regex':
      return `match(url, ${v})`;
  }
}

/**
 * Compile every `regex` page key in ClickHouse (RE2). An RE2 compile error →
 * 400 `invalid_regex` (field = the key); any other error propagates.
 */
export async function assertPageRegexes(
  run: QueryRunner,
  keys: readonly { key: string; matchType?: PageMatchType; value?: string }[],
): Promise<void> {
  const regexes = keys.filter((k) => k.matchType === 'regex' && k.value !== undefined);
  await Promise.all(
    regexes.map(async (k) => {
      try {
        await run("SELECT match('', {re:String}) AS ok", { re: k.value });
      } catch (err) {
        if ((err as { code?: unknown }).code === CANNOT_COMPILE_REGEXP) {
          throw new SyncApiError('invalid_regex', 400, k.key);
        }
        throw err;
      }
    }),
  );
}
