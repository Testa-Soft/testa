/**
 * generate.py `products()`: per-product / per-variant performance by variation.
 */

import type { Model } from './model.ts';
import { fx, itemsOf } from './model.ts';
import { pyRound, r6, ratio } from './pymath.ts';

const DEFAULT_LIMIT = 8;
const LOW_SAMPLE_UNITS = 15;

export type PurchaseType = 'all' | 'initial' | 'upsell';

export interface ProductsOptions {
  readonly limit?: number;
  readonly purchaseType?: PurchaseType;
}

interface VariantAcc {
  units: number;
  rev: number;
}

interface ByAcc {
  added: number;
  units: number;
  rev: number;
  b2cNum: number;
  readonly variants: Map<string, VariantAcc>;
}

interface ProductAcc {
  name: string;
  unitPrice: number | null;
  readonly by: Map<number, ByAcc>;
}

const newBy = (): ByAcc => ({ added: 0, units: 0, rev: 0.0, b2cNum: 0, variants: new Map() });

/** defaultdict access: get-or-create (the oracle relies on its side effects). */
function byOf(p: ProductAcc, v: number): ByAcc {
  const existing = p.by.get(v);
  if (existing) return existing;
  const b = newBy();
  p.by.set(v, b);
  return b;
}

function productOf(P: Map<string, ProductAcc>, pid: string): ProductAcc {
  const existing = P.get(pid);
  if (existing) return existing;
  const p: ProductAcc = { name: '', unitPrice: 0, by: new Map() };
  P.set(pid, p);
  return p;
}

function variantOf(b: ByAcc, name: string): VariantAcc {
  const existing = b.variants.get(name);
  if (existing) return existing;
  const vv = { units: 0, rev: 0.0 };
  b.variants.set(name, vv);
  return vv;
}

function addTo<K>(map: Map<K, number>, key: K, n: number): void {
  map.set(key, (map.get(key) ?? 0) + n);
}

interface Totals {
  readonly units: Map<number, number>;
  readonly rev: Map<number, number>;
}

function accumulate(m: Model, purchaseType: PurchaseType, P: Map<string, ProductAcc>): Totals {
  const tot: Totals = { units: new Map(), rev: new Map() };
  for (const [vid, es] of m.att) {
    const x = m.exposed.get(vid);
    if (!x) throw new Error(`oracle: attributed visitor ${vid} not exposed`);
    const v = x.variationId;
    const carted = new Map<string, number>();
    const bought = new Map<string, number>();
    for (const e of es) {
      if (e.event_name === 'add_to_cart') {
        for (const it of itemsOf(m, e)) {
          byOf(productOf(P, it.product_id), v).added += it.quantity;
          addTo(carted, it.product_id, it.quantity);
        }
      }
      if (e.event_name !== 'purchase') continue;
      if (purchaseType !== 'all' && e.purchase_type !== purchaseType) continue;
      for (const it of itemsOf(m, e)) {
        const p = productOf(P, it.product_id);
        p.name = it.item_name;
        p.unitPrice = it.price || p.unitPrice;
        const rev = (it.price ?? 0) * it.quantity * fx(e.currency);
        const b = byOf(p, v);
        b.units += it.quantity;
        b.rev += rev;
        const vv = variantOf(b, it.item_variant || it.item_id);
        vv.units += it.quantity;
        vv.rev += rev;
        addTo(tot.units, v, it.quantity);
        addTo(tot.rev, v, rev);
        addTo(bought, it.product_id, it.quantity);
      }
    }
    for (const [pid, c] of carted) {
      byOf(productOf(P, pid), v).b2cNum += Math.min(bought.get(pid) ?? 0, c);
    }
  }
  return tot;
}

function entry(m: Model, pid: string, p: ProductAcc, tot: Totals) {
  const ctrl = m.variations[0] ?? 0;
  const byVariation: Record<string, unknown> = {};
  for (const v of m.variations) {
    const b = byOf(p, v);
    byVariation[String(v)] = {
      units_added: b.added,
      units_purchased: b.units,
      units_share: r6(ratio(b.units, tot.units.get(v) ?? 0)),
      buy_to_cart: r6(ratio(b.b2cNum, b.added)),
      revenue: pyRound(b.rev, 2),
      revenue_share: r6(ratio(b.rev, tot.rev.get(v) ?? 0)),
    };
  }
  const names: string[] = [];
  for (const v of m.variations) {
    for (const vn of byOf(p, v).variants.keys()) if (!names.includes(vn)) names.push(vn);
  }
  const variants = names.map((vn) => {
    const sv: Record<string, unknown> = {};
    for (const v of m.variations) {
      const b = byOf(p, v);
      const vv = b.variants.get(vn) ?? { units: 0, rev: 0.0 };
      sv[String(v)] = {
        units: vv.units,
        share_of_product: r6(ratio(vv.units, b.units)),
        revenue_share: r6(ratio(vv.rev, tot.rev.get(v) ?? 0)),
      };
    }
    const ctrlUnits = byOf(p, ctrl).variants.get(vn)?.units ?? 0;
    return { item_variant: vn, by_variation: sv, low_sample: ctrlUnits < LOW_SAMPLE_UNITS };
  });
  return {
    product_id: pid,
    name: p.name,
    unit_price: p.unitPrice,
    by_variation: byVariation,
    variants,
  };
}

function otherProducts(rest: readonly string[], P: Map<string, ProductAcc>): ProductAcc {
  const agg: ProductAcc = { name: 'Other products', unitPrice: null, by: new Map() };
  for (const pid of rest) {
    const p = P.get(pid);
    if (!p) continue;
    for (const [v, b] of p.by) {
      const a = byOf(agg, v);
      a.added += b.added;
      a.units += b.units;
      a.rev += b.rev;
      a.b2cNum += b.b2cNum;
    }
  }
  return agg;
}

export function products(m: Model, opts: ProductsOptions = {}) {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const purchaseType = opts.purchaseType ?? 'all';
  const P = new Map<string, ProductAcc>();
  const tot = accumulate(m, purchaseType, P);
  const ctrl = m.variations[0];
  if (ctrl === undefined) throw new Error('oracle: products needs at least one variation');
  // `sorted(P, key=-P[k]["by"][ctrl]["rev"])` — stable; the lookup creates ctrl entries.
  const keyed = [...P.keys()].map((pid) => {
    const p = P.get(pid);
    return { pid, rev: p ? byOf(p, ctrl).rev : 0 };
  });
  const order = keyed.sort((a, b) => b.rev - a.rev).map((k) => k.pid);
  const out: unknown[] = [];
  for (const pid of order.slice(0, limit)) {
    const p = P.get(pid);
    if (p) out.push(entry(m, pid, p, tot));
  }
  const rest = order.slice(limit);
  if (rest.length > 0) {
    const e = entry(m, '(other)', otherProducts(rest, P), tot);
    out.push({ ...e, variants: [], product_count: rest.length });
  }
  return {
    experiment_id: m.expId,
    from: m.from,
    to: m.to,
    report_currency: m.ccy,
    purchase_type: purchaseType,
    sort: 'control_revenue',
    limit,
    offset: 0,
    total_products: order.length,
    products: out,
  };
}
