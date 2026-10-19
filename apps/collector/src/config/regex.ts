/**
 * Regex helpers shared by the config builder (`starts_with` → pixel regex) and
 * the `page:` metric keys, so both sides compile a prefix the same way.
 */

/** Escape every RegExp metacharacter; the result matches `s` literally (JS and RE2). */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `starts_with` as the pixel understands it: the pixel's `urlMatchesGoal` has
 * no prefix mode, so it gets `^` + the escaped value as a `regex` goal.
 * `new RegExp(startsWithPattern(v)).test(u) === u.startsWith(v)` for every v, u.
 */
export function startsWithPattern(value: string): string {
  return `^${escapeRegExp(value)}`;
}
