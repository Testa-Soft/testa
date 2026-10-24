/**
 * Visitor dimensions and the product catalogue for the staging traffic
 * simulator. Same distributions as fixture F2, so staging screens look like
 * the validated ones.
 */

export type Weighted<T> = readonly [T, number];

export function pick<T>(rand: () => number, options: readonly Weighted<T>[]): T {
  const total = options.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [value, w] of options) {
    r -= w;
    if (r <= 0) return value;
  }
  return (options.at(-1) as Weighted<T>)[0];
}

/** [city, region, country], weighted 1/(rank + 1). */
export const CITIES: readonly Weighted<readonly [string, string, string]>[] = (
  [
    ['Vilnius', 'Vilnius County', 'LT'],
    ['Kaunas', 'Kaunas County', 'LT'],
    ['Riga', 'Riga', 'LV'],
    ['Tallinn', 'Harju County', 'EE'],
    ['Warsaw', 'Masovia', 'PL'],
    ['Berlin', 'Berlin', 'DE'],
    ['Munich', 'Bavaria', 'DE'],
    ['London', 'England', 'GB'],
    ['Dublin', 'Leinster', 'IE'],
    ['Paris', 'Île-de-France', 'FR'],
    ['Madrid', 'Madrid', 'ES'],
    ['Milan', 'Lombardy', 'IT'],
    ['Amsterdam', 'North Holland', 'NL'],
    ['Stockholm', 'Stockholm', 'SE'],
    ['New York', 'New York', 'US'],
  ] as const
).map((c, i) => [c, 1 / (i + 2)] as const);

export const DEVICES: readonly Weighted<string>[] = [
  ['desktop', 0.45],
  ['mobile', 0.47],
  ['tablet', 0.08],
];

/** [channel, entry utm source, medium, referrer domain, click id type]. */
export const CHANNELS: readonly Weighted<readonly [string, string, string, string, string]>[] = [
  [['Direct', '', '', '(direct)', ''], 0.28],
  [['Organic Search', '', '', 'google.com', ''], 0.22],
  [['Paid Search', 'google', 'cpc', 'google.com', 'gclid'], 0.16],
  [['Paid Social', 'facebook', 'paid_social', 'facebook.com', 'fbclid'], 0.12],
  [['Email', 'newsletter', 'email', '(direct)', ''], 0.1],
  [['Referral', '', '', 'blog.runners.example', ''], 0.12],
];

/** [product id, name, unit price, variants]. */
export const PRODUCTS = [
  ['P-RUN', 'Trail Runner', 89, ['Black / US 9', 'Black / US 10', 'White / US 9', 'White / US 10']],
  ['P-JKT', 'Rain Jacket', 149, ['S', 'M', 'L']],
  ['P-TEE', 'Merino Tee', 39, ['S', 'M', 'L']],
  ['P-SOX', 'Wool Socks 3-pack', 19, ['M', 'L']],
  ['P-BAG', 'Day Pack', 69, ['Grey', 'Navy']],
  ['P-BTL', 'Steel Bottle', 29, ['0.5 l', '0.75 l']],
] as const;

export const UPSELL = ['P-CARE', 'Shoe Care Kit', 18] as const;
