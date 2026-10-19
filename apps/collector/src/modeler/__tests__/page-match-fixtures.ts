/**
 * Shared fixture table for page-key URL matching: every rule is evaluated on
 * every URL by BOTH the pixel's `urlMatchesGoal` and the ClickHouse predicate
 * (`pageMatchSql`); the two must agree cell by cell.
 */
import type { PageMatchType } from '../page-keys.ts';

export interface PageRule {
  matchType: PageMatchType;
  value: string;
}

export const URLS: readonly string[] = [
  'https://shop.example/',
  'https://shop.example/thanks',
  'https://shop.example/thanks?order=42',
  'https://shop.example/thanks/again',
  'https://shop.example/THANKS',
  'http://shop.example/thanks',
  'https://www.shop.example/thanks',
  'https://shop.example/checkout?step=2&ref=a.b',
  'https://shop.example/checkout?step=22',
  'https://shop.example/p/123-blue-shoe',
  'https://shop.example/p/abc',
  'https://shop.example/search?q=a+b',
  'https://shop.example/search?q=a%20b',
  'https://shop.example/%C3%A9t%C3%A9/sale',
  'https://shop.example/pricing#plans',
  'https://shop.example/cart(1)',
  'https://shop.example/a.b/c',
  'https://shop.example/axb/c',
  'https://shop.example/en-gb/',
  '',
];

export const RULES: readonly PageRule[] = [
  { matchType: 'exact', value: 'https://shop.example/thanks' },
  { matchType: 'exact', value: 'https://shop.example/' },
  { matchType: 'exact', value: 'https://shop.example/cart(1)' },
  { matchType: 'contains', value: '/thanks' },
  { matchType: 'contains', value: 'step=2' },
  { matchType: 'contains', value: 'q=a+b' },
  { matchType: 'contains', value: '%C3%A9t%C3%A9' },
  { matchType: 'contains', value: '#plans' },
  { matchType: 'contains', value: 'a.b' },
  { matchType: 'starts_with', value: 'https://shop.example/thanks' },
  { matchType: 'starts_with', value: 'https://shop.example/a.b' },
  { matchType: 'starts_with', value: 'https://shop.example/cart(' },
  { matchType: 'starts_with', value: 'http://' },
  { matchType: 'starts_with', value: 'https://shop.example/search?q=a+' },
  { matchType: 'regex', value: '/thanks$' },
  { matchType: 'regex', value: '^https://shop\\.example/thanks(\\?|$)' },
  { matchType: 'regex', value: '/p/\\d+(-[a-z]+)*$' },
  { matchType: 'regex', value: 'step=2(&|$)' },
  { matchType: 'regex', value: 'a.b' },
  { matchType: 'regex', value: '/(en|de)-[a-z]{2}/' },
  { matchType: 'regex', value: 'THANKS|pricing' },
  { matchType: 'regex', value: '^https?://(www\\.)?shop\\.example/thanks' },
  { matchType: 'regex', value: '\\bsale\\b' },
  { matchType: 'regex', value: '[?&]q=[^&]*\\+' },
  { matchType: 'regex', value: 'cart\\(1\\)' },
  { matchType: 'regex', value: '\\x41|%20' },
  { matchType: 'regex', value: '(?<slug>[a-z]+)/c$' },
  { matchType: 'regex', value: 'shop.example/?$' },
  { matchType: 'regex', value: '^$' },
];

/** Regexes both engines can't agree on → 400 `invalid_regex`. `where` = which check catches it. */
export const REJECTED_REGEXES: readonly { value: string; where: 'static' | 're2' }[] = [
  { value: '(?i)thanks', where: 'static' }, // JS: invalid group; RE2: case-insensitive flag
  { value: '(?P<n>x)', where: 'static' }, // JS rejects, RE2 accepts
  { value: '(', where: 'static' }, // neither compiles
  { value: '\\p{L}+', where: 'static' }, // JS (no u flag): literal "p{L}"; RE2: Unicode letters
  { value: '\\Athanks', where: 'static' }, // JS: literal "A"; RE2: start of text
  { value: '\\x{41}', where: 'static' }, // JS: literal "x{41}"; RE2: "A"
  { value: '(a)\\1', where: 'static' }, // backreference: RE2 has none
  { value: '\\u0041', where: 'static' }, // RE2 has no \u escape
  { value: '\\cA', where: 'static' },
  { value: '/thanks(?=\\?)', where: 're2' }, // lookahead
  { value: '(?<!www\\.)shop', where: 're2' }, // lookbehind
  { value: '[^]', where: 're2' }, // JS: any char; RE2: unterminated class
  { value: 'a{1001}', where: 're2' }, // RE2 repeat limit is 1000
  { value: '[\\b]', where: 're2' }, // JS: backspace; RE2: invalid escape in class
];

/** `page:<type>:<encodeURIComponent(value)>`. */
export const pageKey = (r: PageRule): string =>
  `page:${r.matchType}:${encodeURIComponent(r.value)}`;
