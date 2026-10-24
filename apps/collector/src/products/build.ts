/**
 * Pure assembly of the `products` view (PRD-006 §6.5) from `ItemGroup`s,
 * mirroring the oracle `generate.py products()`: product × variation values,
 * the variants tree, the "Other products" fold, and detail mode.
 */
import type {
  ByVariation,
  ProductDetailResult,
  ProductRow,
  ProductVariant,
  ProductVariationValues,
  ProductsListResult,
  ProductsPurchaseType,
  ProductsSort,
} from '@testa-platform/shared-types';
import { roundHalfEven } from '../modeler/round.ts';
import type { ItemGroup, OrderKey } from './query.ts';

/** §6.5: a variant with fewer control units is `low_sample`. */
export const LOW_SAMPLE_UNITS = 15;
export const MAX_VARIANTS = 10;
export const OTHER_ID = '(other)';
export const OTHER_PRODUCTS = 'Other products';

export interface ProductsBase {
  experiment_id: number;
  from: string;
  to: string;
  report_currency: string;
  purchase_type: ProductsPurchaseType;
}

export interface ListOptions {
  sort: ProductsSort;
  limit: number;
  offset: number;
  search?: string;
}

/** Order of first appearance: oracle visitor walk, ties by visitor id. */
interface Seen {
  key: OrderKey;
  visitor: string;
}

interface VariantAcc {
  units: number;
  revenue: number;
  item_id: string;
  seen: Seen;
}

interface VariationAcc {
  added: number;
  units: number;
  revenue: number;
  b2c: number;
  variants: Map<string, VariantAcc>;
}

interface ProductAcc {
  id: string;
  seen: Seen;
  name: string;
  nameAt: Seen | null;
  price: number;
  priceAt: Seen | null;
  by: Map<number, VariationAcc>;
}

/** Python `round(x, dp)` parity (ties to even on the exact value), like the oracle. */
const round = (x: number, dp: number): number => roundHalfEven(x, dp);
const ratio6 = (a: number, b: number): number | null => (b ? round(a / b, 6) : null);

function cmpSeen(a: Seen, b: Seen): number {
  return a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.visitor.localeCompare(b.visitor);
}

const earlier = (a: Seen, b: Seen): Seen => (cmpSeen(a, b) <= 0 ? a : b);

const emptyVariation = (): VariationAcc => ({
  added: 0,
  units: 0,
  revenue: 0,
  b2c: 0,
  variants: new Map(),
});

export interface Catalog {
  /** Variation ids: config order (control first), then any extra seen in data. */
  variations: number[];
  products: ProductAcc[];
  totals: Map<number, { units: number; revenue: number }>;
}

export function buildCatalog(groups: ItemGroup[], configVariations: number[]): Catalog {
  const products = new Map<string, ProductAcc>();
  const product = (g: ItemGroup, seen: Seen): ProductAcc => {
    const p = products.get(g.product_id) ?? {
      id: g.product_id,
      seen,
      name: '',
      nameAt: null,
      price: 0,
      priceAt: null,
      by: new Map(),
    };
    p.seen = earlier(p.seen, seen);
    products.set(g.product_id, p);
    return p;
  };
  const variation = (p: ProductAcc, id: number): VariationAcc => {
    const acc = p.by.get(id) ?? emptyVariation();
    p.by.set(id, acc);
    return acc;
  };

  for (const g of groups) {
    const seen = { key: g.first, visitor: g.visitor_id };
    const p = product(g, seen);
    const acc = variation(p, g.variation_id);
    if (g.kind === 'cart') {
      acc.added += g.quantity;
      continue;
    }
    acc.units += g.quantity;
    acc.revenue += g.revenue;
    const v = acc.variants.get(g.variant);
    acc.variants.set(g.variant, {
      units: (v?.units ?? 0) + g.quantity,
      revenue: (v?.revenue ?? 0) + g.revenue,
      item_id: v && cmpSeen(v.seen, seen) <= 0 ? v.item_id : g.item_id,
      seen: v ? earlier(v.seen, seen) : seen,
    });
    const last = { key: g.last, visitor: g.visitor_id };
    if (!p.nameAt || cmpSeen(last, p.nameAt) > 0) {
      p.name = g.name;
      p.nameAt = last;
    }
    if (g.price_key) {
      const at = { key: g.price_key, visitor: g.visitor_id };
      if (!p.priceAt || cmpSeen(at, p.priceAt) > 0) {
        p.price = g.price;
        p.priceAt = at;
      }
    }
  }
  addBuyToCart(groups, products);

  const extra = [...new Set(groups.map((g) => g.variation_id))]
    .filter((id) => !configVariations.includes(id))
    .sort((a, b) => a - b);
  const variations = [...configVariations, ...extra];
  const all = [...products.values()];
  const totals = new Map(
    variations.map((v) => [
      v,
      all.reduce(
        (t, p) => ({
          units: t.units + (p.by.get(v)?.units ?? 0),
          revenue: t.revenue + (p.by.get(v)?.revenue ?? 0),
        }),
        { units: 0, revenue: 0 },
      ),
    ]),
  );
  return { variations, products: all, totals };
}

/** §2.3: Σ min(bought, carted) per visitor × product, credited to the visitor's variation. */
function addBuyToCart(groups: ItemGroup[], products: Map<string, ProductAcc>): void {
  const per = new Map<
    string,
    { variation: number; product: string; carted: number; bought: number }
  >();
  for (const g of groups) {
    const key = `${g.visitor_id}\u0000${g.product_id}`;
    const acc = per.get(key) ?? {
      variation: g.variation_id,
      product: g.product_id,
      carted: 0,
      bought: 0,
    };
    if (g.kind === 'cart') acc.carted += g.quantity;
    else acc.bought += g.quantity;
    per.set(key, acc);
  }
  for (const acc of per.values()) {
    if (acc.carted === 0) continue;
    const v = products.get(acc.product)?.by.get(acc.variation);
    if (v) v.b2c += Math.min(acc.bought, acc.carted);
  }
}

function variationValues(
  acc: VariationAcc | undefined,
  total: { units: number; revenue: number },
): ProductVariationValues {
  const a = acc ?? emptyVariation();
  return {
    units_added: a.added,
    units_purchased: a.units,
    units_share: ratio6(a.units, total.units),
    buy_to_cart: ratio6(a.b2c, a.added),
    revenue: round(a.revenue, 2),
    revenue_share: ratio6(a.revenue, total.revenue),
  };
}

const byVariation = <T>(c: Catalog, f: (id: number) => T): ByVariation<T> =>
  Object.fromEntries(c.variations.map((id) => [String(id), f(id)]));

const totalOf = (c: Catalog, id: number) => c.totals.get(id) ?? { units: 0, revenue: 0 };

/** Variant names: by variation (config order), then first appearance within it. */
function variantOrder(c: Catalog, p: ProductAcc): string[] {
  const names: string[] = [];
  for (const id of c.variations) {
    const entries = [...(p.by.get(id)?.variants ?? new Map<string, VariantAcc>())].sort((a, b) =>
      cmpSeen(a[1].seen, b[1].seen),
    );
    for (const [name] of entries) if (!names.includes(name)) names.push(name);
  }
  return names;
}

function variantRow(c: Catalog, p: ProductAcc, names: string[], label: string): ProductVariant {
  const control = c.variations[0];
  const pick = (id: number) =>
    names.reduce(
      (s, n) => {
        const v = p.by.get(id)?.variants.get(n);
        return { units: s.units + (v?.units ?? 0), revenue: s.revenue + (v?.revenue ?? 0) };
      },
      { units: 0, revenue: 0 },
    );
  return {
    item_variant: label,
    by_variation: byVariation(c, (id) => {
      const v = pick(id);
      return {
        units: v.units,
        share_of_product: ratio6(v.units, p.by.get(id)?.units ?? 0),
        revenue_share: ratio6(v.revenue, totalOf(c, id).revenue),
      };
    }),
    low_sample: (control === undefined ? 0 : pick(control).units) < LOW_SAMPLE_UNITS,
  };
}

/** Top 10 variants (by units, all variations) in tree order, the rest as one `(other)` row. */
function variantRows(c: Catalog, p: ProductAcc): ProductVariant[] {
  const names = variantOrder(c, p);
  if (names.length <= MAX_VARIANTS) return names.map((n) => variantRow(c, p, [n], n));
  const units = (n: string) =>
    c.variations.reduce((s, id) => s + (p.by.get(id)?.variants.get(n)?.units ?? 0), 0);
  const top = new Set([...names].sort((a, b) => units(b) - units(a)).slice(0, MAX_VARIANTS));
  return [
    ...names.filter((n) => top.has(n)).map((n) => variantRow(c, p, [n], n)),
    variantRow(
      c,
      p,
      names.filter((n) => !top.has(n)),
      OTHER_ID,
    ),
  ];
}

function productRow(c: Catalog, p: ProductAcc): ProductRow {
  return {
    product_id: p.id,
    name: p.name,
    unit_price: p.price,
    by_variation: byVariation(c, (id) => variationValues(p.by.get(id), totalOf(c, id))),
    variants: variantRows(c, p),
  };
}

function otherRow(c: Catalog, rest: ProductAcc[]): ProductRow {
  const sum = (id: number): VariationAcc => {
    const parts = rest.map((p) => p.by.get(id)).filter((b): b is VariationAcc => b !== undefined);
    const total = (f: (b: VariationAcc) => number) => parts.reduce((s, b) => s + f(b), 0);
    return {
      added: total((b) => b.added),
      units: total((b) => b.units),
      revenue: total((b) => b.revenue),
      b2c: total((b) => b.b2c),
      variants: new Map(),
    };
  };
  return {
    product_id: OTHER_ID,
    name: OTHER_PRODUCTS,
    unit_price: null,
    by_variation: byVariation(c, (id) => variationValues(sum(id), totalOf(c, id))),
    variants: [],
    product_count: rest.length,
  };
}

function ranked(c: Catalog, sort: ProductsSort, search: string | undefined): ProductAcc[] {
  const needle = search?.trim().toLowerCase();
  const control = c.variations[0];
  const score = (p: ProductAcc): number =>
    sort === 'control_revenue'
      ? control === undefined
        ? 0
        : (p.by.get(control)?.revenue ?? 0)
      : c.variations.reduce((s, id) => {
          const t = totalOf(c, id).revenue;
          return s + (t ? (p.by.get(id)?.revenue ?? 0) / t : 0);
        }, 0);
  return c.products
    .filter(
      (p) =>
        !needle || p.id.toLowerCase().includes(needle) || p.name.toLowerCase().includes(needle),
    )
    .sort((a, b) => score(b) - score(a) || cmpSeen(a.seen, b.seen));
}

export function buildProductsList(
  c: Catalog,
  base: ProductsBase,
  o: ListOptions,
): ProductsListResult {
  const order = ranked(c, o.sort, o.search);
  const page = order.slice(o.offset, o.offset + o.limit);
  const rest = order.slice(o.offset + o.limit);
  return {
    ...base,
    sort: o.sort,
    limit: o.limit,
    offset: o.offset,
    total_products: order.length,
    products: [...page.map((p) => productRow(c, p)), ...(rest.length ? [otherRow(c, rest)] : [])],
  };
}

export function buildProductDetail(
  c: Catalog,
  base: ProductsBase,
  productId: string,
): ProductDetailResult {
  const p = c.products.find((x) => x.id === productId);
  const values = (id: number) => variationValues(p?.by.get(id), totalOf(c, id));
  return {
    ...base,
    product_id: productId,
    variants: p
      ? variantOrder(c, p).map((name) => {
          const first = c.variations
            .map((id) => p.by.get(id)?.variants.get(name))
            .filter((v): v is VariantAcc => v !== undefined)
            .sort((a, b) => cmpSeen(a.seen, b.seen))[0];
          return {
            item_variant: name,
            item_id: first?.item_id ?? name,
            share: byVariation(c, (id) =>
              ratio6(p.by.get(id)?.variants.get(name)?.units ?? 0, p.by.get(id)?.units ?? 0),
            ),
            units: byVariation(c, (id) => p.by.get(id)?.variants.get(name)?.units ?? 0),
          };
        })
      : [],
    kpis: {
      units_purchased: byVariation(c, (id) => values(id).units_purchased),
      buy_to_cart: byVariation(c, (id) => values(id).buy_to_cart),
      revenue_share: byVariation(c, (id) => values(id).revenue_share),
    },
  };
}
