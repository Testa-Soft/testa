/** Products assembly (task 5.16): folds and edge cases the goldens don't reach. */
import { describe, expect, it } from 'bun:test';
import {
  type ProductsBase,
  buildCatalog,
  buildProductDetail,
  buildProductsList,
} from '../build.ts';
import type { ItemGroup } from '../query.ts';

const BASE: ProductsBase = {
  experiment_id: 1,
  from: '2026-10-01',
  to: '2026-10-03',
  report_currency: 'EUR',
  purchase_type: 'all',
};

let clock = 0;
function g(over: Partial<ItemGroup>): ItemGroup {
  clock += 1;
  return {
    variation_id: 100,
    visitor_id: `v${clock}`,
    product_id: 'P',
    variant: 'Default',
    item_id: 'P-1',
    kind: 'buy',
    quantity: 1,
    revenue: 10,
    first: [clock, clock],
    last: [clock, clock],
    name: 'Product',
    price: 10,
    price_key: [clock, clock],
    ...over,
  };
}

const LIST = { sort: 'control_revenue', limit: 8, offset: 0 } as const;

describe('products list', () => {
  it('beyond the limit folds into one "Other products" row with summed values', () => {
    const groups = ['A', 'B', 'C'].map((id, i) =>
      g({ product_id: id, revenue: 30 - i * 10, quantity: 1 }),
    );
    const r = buildProductsList(buildCatalog(groups, [100]), BASE, { ...LIST, limit: 1 });
    expect(r.total_products).toBe(3);
    expect(r.products.map((p) => p.product_id)).toEqual(['A', '(other)']);
    expect(r.products[1]).toMatchObject({
      name: 'Other products',
      unit_price: null,
      variants: [],
      product_count: 2,
      by_variation: { '100': { units_purchased: 2, revenue: 30, revenue_share: 0.5 } },
    });
  });

  it('more than 10 variants: top 10 by units in tree order, the rest as (other)', () => {
    const groups = Array.from({ length: 12 }, (_, i) =>
      g({ variant: `V${i}`, quantity: i === 0 ? 1 : 2 }),
    );
    const [row] = buildProductsList(buildCatalog(groups, [100]), BASE, LIST).products;
    expect(row?.variants.map((v) => v.item_variant)).toEqual([
      'V1',
      'V2',
      'V3',
      'V4',
      'V5',
      'V6',
      'V7',
      'V8',
      'V9',
      'V10',
      '(other)',
    ]);
    expect(row?.variants.at(-1)?.by_variation['100']?.units).toBe(3);
  });

  it('buy_to_cart caps bought at carted per visitor × product', () => {
    const groups = [
      g({ visitor_id: 'a', kind: 'cart', quantity: 2, revenue: 0 }),
      g({ visitor_id: 'a', quantity: 5 }),
      g({ visitor_id: 'b', kind: 'cart', quantity: 2, revenue: 0 }),
    ];
    const [row] = buildProductsList(buildCatalog(groups, [100]), BASE, LIST).products;
    expect(row?.by_variation['100']).toMatchObject({ units_added: 4, buy_to_cart: 0.5 });
  });

  it('name and unit_price come from the latest purchase; a carted-only product has neither', () => {
    const groups = [
      g({ product_id: 'P', name: 'Old', price: 50, last: [1, 1], price_key: [1, 1] }),
      g({ product_id: 'P', name: 'New', price: 40, last: [9, 9], price_key: [9, 9] }),
      g({ product_id: 'Q', kind: 'cart', revenue: 0 }),
    ];
    const r = buildProductsList(buildCatalog(groups, [100]), BASE, LIST);
    expect(r.products.map((p) => [p.product_id, p.name, p.unit_price])).toEqual([
      ['P', 'New', 40],
      ['Q', '', 0],
    ]);
    expect(r.products[1]?.variants).toEqual([]);
  });

  it('revenue_share sort ranks by summed share across variations; search filters', () => {
    const groups = [
      g({ product_id: 'A', variation_id: 100, revenue: 60 }),
      g({ product_id: 'B', variation_id: 100, revenue: 40 }),
      g({ product_id: 'B', variation_id: 101, revenue: 100 }),
    ];
    const catalog = buildCatalog(groups, [100, 101]);
    const byShare = buildProductsList(catalog, BASE, { ...LIST, sort: 'revenue_share' });
    expect(byShare.products.map((p) => p.product_id)).toEqual(['B', 'A']);
    const searched = buildProductsList(catalog, BASE, { ...LIST, search: 'a' });
    expect(searched.products.map((p) => p.product_id)).toEqual(['A']);
  });

  it('a variation in data but not in config is kept', () => {
    const r = buildProductsList(buildCatalog([g({ variation_id: 999 })], [100]), BASE, LIST);
    expect(Object.keys(r.products[0]?.by_variation ?? {})).toEqual(['100', '999']);
    expect(r.products[0]?.by_variation['100']?.units_share).toBeNull();
  });
});

describe('product detail', () => {
  it('variants with item_id and shares; unknown product → empty', () => {
    const groups = [
      g({ variant: 'Red', item_id: 'P-R', quantity: 3 }),
      g({ variant: 'Blue', item_id: 'P-B', quantity: 1 }),
    ];
    const catalog = buildCatalog(groups, [100]);
    const d = buildProductDetail(catalog, BASE, 'P');
    expect(d.variants).toEqual([
      { item_variant: 'Red', item_id: 'P-R', share: { '100': 0.75 }, units: { '100': 3 } },
      { item_variant: 'Blue', item_id: 'P-B', share: { '100': 0.25 }, units: { '100': 1 } },
    ]);
    expect(d.kpis.units_purchased).toEqual({ '100': 4 });
    const none = buildProductDetail(catalog, BASE, 'nope');
    expect(none.variants).toEqual([]);
    expect(none.kpis).toEqual({
      units_purchased: { '100': 0 },
      buy_to_cart: { '100': null },
      revenue_share: { '100': 0 },
    });
  });

  it('V13: shares round half-to-even like the oracle (37/128 → 0.289062, 91/128 → 0.710938)', () => {
    const groups = [
      g({ product_id: 'A', quantity: 37, revenue: 37 }),
      g({ product_id: 'B', quantity: 91, revenue: 91 }),
    ];
    const r = buildProductsList(buildCatalog(groups, [100]), BASE, LIST);
    const share = (id: string) =>
      r.products.find((p) => p.product_id === id)?.by_variation['100']?.units_share;
    expect(share('A')).toBe(0.289062);
    expect(share('B')).toBe(0.710938);
  });
});
