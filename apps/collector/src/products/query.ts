/**
 * ClickHouse read for the `products` view (PRD-006 §6.5, task 5.16): item
 * rows of attributed `add_to_cart` / `purchase` events (purchases deduped,
 * exposure variation), summed per variation × visitor × product × variant ×
 * kind. Revenue converts at the previous day's FX rate (`withFx`).
 *
 * Order keys mirror the oracle (`generate.py products()`), which walks visitors
 * in first-exposure order and their events in time order: `first_*` / `last_*`
 * are `[first_exposed_at ms, client_ts ms]`.
 */
import type { ProductsPurchaseType } from '@testa-platform/shared-types';
import {
  type AttributionScope,
  type QueryRunner,
  buildAttributedEvents,
} from '../analytics/attribution.ts';
import { withFx } from '../modeler/fx.ts';

export type OrderKey = [number, number];

export interface ItemGroup {
  variation_id: number;
  visitor_id: string;
  product_id: string;
  /** `item_variant`, falling back to `item_id`. */
  variant: string;
  /** First item_id seen for the variant (detail mode). */
  item_id: string;
  kind: 'cart' | 'buy';
  quantity: number;
  /** Report currency; 0 for carts. */
  revenue: number;
  first: OrderKey;
  last: OrderKey;
  /** item_name at `last`. */
  name: string;
  /** Latest non-zero price (native currency) and its key; key null when none. */
  price: number;
  price_key: OrderKey | null;
}

export interface ProductsScope extends AttributionScope {
  reportCurrency: string;
  purchaseType: ProductsPurchaseType;
}

const KEY = '(toUnixTimestamp64Milli(w.first_exposed_at), toUnixTimestamp64Milli(w.client_ts))';

export async function fetchItemGroups(
  query: QueryRunner,
  scope: ProductsScope,
): Promise<ItemGroup[]> {
  const attributed = buildAttributedEvents({
    ...scope,
    eventNames: ['add_to_cart', 'purchase'],
  });
  const rows = await query<Record<string, unknown>>(
    `SELECT
      toUInt32(w.variation_id) AS variation_id,
      w.visitor_id AS visitor_id,
      i.product_id AS product_id,
      if(i.item_variant != '', i.item_variant, i.item_id) AS variant,
      argMin(i.item_id, ${KEY}) AS item_id,
      if(w.event_name = 'add_to_cart', 'cart', 'buy') AS kind,
      toUInt32(sum(i.quantity)) AS quantity,
      sumIf(toFloat64(i.price) * i.quantity * w.fx, w.event_name = 'purchase') AS revenue,
      min(${KEY}) AS first,
      max(${KEY}) AS last,
      argMax(i.item_name, ${KEY}) AS name,
      toFloat64(argMaxIf(i.price, ${KEY}, i.price != 0)) AS price,
      toUInt32(countIf(i.price != 0)) AS priced,
      maxIf(${KEY}, i.price != 0) AS price_key
    FROM (${withFx(attributed.sql)}) AS w
    INNER JOIN event_items AS i ON i.event_id = w.event_id
    WHERE i.project_id = {project_id:UInt64}
      AND (w.event_name = 'add_to_cart'
        OR {purchase_type:String} = 'all'
        OR w.purchase_type = {purchase_type:String})
    GROUP BY variation_id, visitor_id, product_id, variant, kind`,
    {
      ...attributed.params,
      report_currency: scope.reportCurrency,
      purchase_type: scope.purchaseType,
    },
  );
  return rows.map(toGroup);
}

const toKey = (v: unknown): OrderKey => {
  const [a, b] = v as [unknown, unknown];
  return [Number(a), Number(b)];
};

function toGroup(r: Record<string, unknown>): ItemGroup {
  return {
    variation_id: Number(r.variation_id),
    visitor_id: String(r.visitor_id),
    product_id: String(r.product_id),
    variant: String(r.variant),
    item_id: String(r.item_id),
    kind: r.kind === 'cart' ? 'cart' : 'buy',
    quantity: Number(r.quantity),
    revenue: Number(r.revenue),
    first: toKey(r.first),
    last: toKey(r.last),
    name: String(r.name),
    price: Number(r.price),
    price_key: Number(r.priced) === 0 ? null : toKey(r.price_key),
  };
}
