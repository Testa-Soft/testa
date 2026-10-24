/**
 * PRD-006 typed tracking helpers (§1.5–1.8, task 5.7): pure builders shared by
 * the pixel (`window._testa.track*`) and `@testa-soft/next` / react (`track*`),
 * so every surface sends identical payloads.
 *
 * Each builder returns `[eventName, props]` where `props` holds the PRD's
 * top-level commerce fields (value_native, currency, items, order_id, …) plus
 * the purchase / lead extras that belong in the flat `props` bag. Transports
 * lift the top-level keys out (see LIFTED_EVENT_KEYS).
 *
 * Revenue convention (decided): `value_native` = Σ price × quantity − order
 * discount, EXCLUDING tax and shipping (kept separately in props).
 */
import type { Item, PurchaseType } from '@testa-platform/shared-types';

export type TrackProps = Record<string, unknown>;
export type TrackCall = [eventName: string, props: TrackProps];

/** Keys transports put on the event envelope instead of the flat `props` bag. */
export const LIFTED_EVENT_KEYS = [
  'value_native',
  'currency',
  'order_id',
  'items_count',
  'items',
  'purchase_type',
  'parent_order_id',
  'cart_id',
  'page_type',
] as const;

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Σ price × quantity (quantity defaults to 1) − order-level discount. */
export function itemsValue(items: readonly Item[], discount = 0): number {
  const gross = items.reduce((sum, it) => sum + (it.price ?? 0) * (it.quantity ?? 1), 0);
  return round2(gross - discount);
}

function withOptional<T extends TrackProps>(base: T, extra: Record<string, unknown>): T {
  const out: TrackProps = { ...base };
  for (const [k, v] of Object.entries(extra))
    if (v !== undefined && v !== null && v !== '') out[k] = v;
  return out as T;
}

export interface CartOptions {
  currency: string;
  cart_id?: string;
  /** Overrides the computed Σ price × qty. */
  value?: number;
  /** Order-level discount subtracted from the computed value. */
  discount?: number;
}

/** `add_to_cart` (PRD §1.7). */
export function addToCart(items: readonly Item[], opts: CartOptions): TrackCall {
  return [
    'add_to_cart',
    withOptional(
      {
        value_native: opts.value ?? itemsValue(items, opts.discount),
        currency: opts.currency,
        items: [...items],
      },
      { cart_id: opts.cart_id },
    ),
  ];
}

const unitsOf = (items: readonly Item[]): number =>
  items.reduce((n, it) => n + (it.quantity ?? 1), 0);

/** `begin_checkout` (PRD §1.7, which shows items_count on it). */
export function beginCheckout(items: readonly Item[], opts: CartOptions): TrackCall {
  return [
    'begin_checkout',
    withOptional(
      {
        value_native: opts.value ?? itemsValue(items, opts.discount),
        currency: opts.currency,
        items_count: unitsOf(items),
        items: [...items],
      },
      { cart_id: opts.cart_id },
    ),
  ];
}

/** `add_shipping_info` — contact / shipping details step (GA4). */
export function shippingInfo(opts: { cart_id?: string } = {}): TrackCall {
  return ['add_shipping_info', withOptional({}, { cart_id: opts.cart_id })];
}

export interface PaymentInfoOptions {
  /** Required (PRD §6.5 health spec). */
  payment_type: string;
  coupon?: string;
  cart_id?: string;
  value?: number;
  currency?: string;
}

/** `add_payment_info` — payment step (GA4); `payment_type` is required. */
export function paymentInfo(opts: PaymentInfoOptions): TrackCall {
  if (!opts.payment_type) throw new Error('trackPaymentInfo: payment_type is required');
  return [
    'add_payment_info',
    withOptional(
      { payment_type: opts.payment_type },
      {
        coupon: opts.coupon,
        cart_id: opts.cart_id,
        value_native: opts.value,
        currency: opts.value !== undefined ? opts.currency : undefined,
      },
    ),
  ];
}

export interface PurchaseOptions {
  order_id: string;
  currency: string;
  items: readonly Item[];
  /** Item revenue net of discounts, excl. tax + shipping; computed from items when omitted. */
  value?: number;
  /** Order-level discount subtracted from the computed value (also sent in props). */
  discount?: number;
  purchase_type?: PurchaseType;
  /** Required when purchase_type = 'upsell'. */
  parent_order_id?: string;
  cart_id?: string;
  tax?: number;
  shipping?: number;
  coupon?: string;
  payment_type?: string;
  upsell_offer_id?: string;
}

/** `purchase` (PRD §1.5, §1.7). */
export function purchase(opts: PurchaseOptions): TrackCall {
  const purchaseType = opts.purchase_type ?? 'initial';
  if (purchaseType === 'upsell' && !opts.parent_order_id) {
    throw new Error('trackPurchase: an upsell needs parent_order_id');
  }
  const items = [...opts.items];
  return [
    'purchase',
    withOptional(
      {
        order_id: opts.order_id,
        purchase_type: purchaseType,
        value_native: opts.value ?? itemsValue(items, opts.discount),
        currency: opts.currency,
        items,
        items_count: unitsOf(items),
      },
      {
        parent_order_id: opts.parent_order_id,
        cart_id: opts.cart_id,
        tax: opts.tax,
        shipping: opts.shipping,
        discount: opts.discount,
        coupon: opts.coupon,
        payment_type: opts.payment_type,
        upsell_offer_id: opts.upsell_offer_id,
      },
    ),
  ];
}

/** `generate_lead` (GA4). ⚠ Not `lead_generated` (the 3.3.3 participation signal). */
export function lead(
  opts: { lead_type?: string; form_id?: string; method?: string } = {},
): TrackCall {
  return [
    'generate_lead',
    withOptional({}, { lead_type: opts.lead_type, form_id: opts.form_id, method: opts.method }),
  ];
}

/** `sign_up` (GA4). */
export function signUp(opts: { method?: string } = {}): TrackCall {
  return ['sign_up', withOptional({}, { method: opts.method })];
}
