/**
 * Regex helpers shared by the config builder (`starts_with` → pixel regex) and
 * the `page:` metric keys, so both sides compile a prefix the same way.
 */

/** Escape every RegExp metacharacter; the result matches `s` literally (JS and RE2). */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A URL's scheme and host (`https://shop.example`), so a path pattern can follow. */
const AUTHORITY = '^[a-z][a-z0-9+.-]*://[^/?#]*';

/**
 * A page-goal value starting with "/" is a path (`/thank-you`), which is what
 * people type: `exact` and `starts_with` then compare it with the URL after
 * its scheme and host. Any other value is compared with the whole URL.
 */
export const isPathValue = (value: string): boolean => value.startsWith('/');

/**
 * `starts_with` as the pixel understands it: the pixel's `urlMatchesGoal` has
 * no prefix mode, so it gets a `regex` goal: `^` + the escaped value, or for a
 * path, the scheme and host + the escaped path. For a full-URL value,
 * `new RegExp(startsWithPattern(v)).test(u) === u.startsWith(v)` for every u.
 */
export function startsWithPattern(value: string): string {
  return isPathValue(value) ? `${AUTHORITY}${escapeRegExp(value)}` : `^${escapeRegExp(value)}`;
}

/**
 * The rule the pixel and ClickHouse both evaluate for a page goal: a path
 * value under `exact` or `starts_with` becomes a regex anchored after the
 * URL's scheme and host; everything else is unchanged.
 */
export function pagePattern<T extends string>(
  matchType: T,
  value: string,
): { matchType: T | 'regex'; value: string } {
  if (!isPathValue(value)) return { matchType, value };
  if (matchType === 'starts_with') return { matchType: 'regex', value: startsWithPattern(value) };
  if (matchType === 'exact')
    return { matchType: 'regex', value: `${AUTHORITY}${escapeRegExp(value)}$` };
  return { matchType, value };
}
