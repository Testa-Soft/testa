/**
 * Pixel event validation + normalisation at the edge (PRD-006 §1.4–1.6, task 5.3).
 *
 * Rejects (returns null for) an event whose envelope or PRD-006 commerce data
 * is invalid; the rest of the batch still goes through. Normalises:
 *   - `checkout_start` → `begin_checkout` (deprecated alias)
 *   - `items`: more than 50 → keep the first 50, `props._items_truncated = 1`
 *   - `items_count` = Σ quantity (default 1) when missing
 *   - `exp` tuples: `[exp, var, session_start]` (older pixels) → `session_idx` 0
 *   - `screen_w` / `screen_h` default 0, `exp` default `[]` (pre-PRD-006 pixels)
 *   - unknown `page_type` / `click_id_type` values are dropped, not fatal
 */
import type { ExpSession, Item, PixelEvent } from '@testa-platform/shared-types';
import { z } from 'zod';

export const MAX_ITEMS = 50;
const MAX_STRING = 256;

const str = z.string().max(MAX_STRING);
const nonNegInt = z.number().int().min(0);

const itemSchema = z
  .object({
    item_id: z.string().min(1).max(128),
    product_id: str.min(1).optional(),
    item_name: str.optional(),
    item_variant: str.optional(),
    item_brand: str.optional(),
    item_category: str.optional(),
    item_category2: str.optional(),
    item_category3: str.optional(),
    item_category4: str.optional(),
    item_category5: str.optional(),
    price: z.number().finite().min(0).optional(),
    quantity: z.number().int().min(1).max(9999).optional(),
    discount: z.number().finite().min(0).optional(),
    coupon: str.optional(),
    item_list_id: str.optional(),
    item_list_name: str.optional(),
    index: nonNegInt.optional(),
  })
  .strip();

const expTuple = z.union([
  z.tuple([nonNegInt, nonNegInt, nonNegInt, nonNegInt]),
  z.tuple([nonNegInt, nonNegInt, nonNegInt]),
]);

const PAGE_TYPES = [
  'home',
  'category',
  'product',
  'search',
  'cart',
  'checkout',
  'thank_you',
  'other',
] as const;
const CLICK_ID_TYPES = [
  'gclid',
  'gbraid',
  'wbraid',
  'fbclid',
  'msclkid',
  'ttclid',
  'li_fat_id',
] as const;

const eventSchema = z
  .object({
    event_id: z.string().min(1),
    event_name: z.string().min(1),
    client_ts: z.number().finite(),
    project_id: z.number().finite(),
    visitor_id: z.string(),
    session_id: z.string(),
    url: z.string(),
    tracker_version: z.string(),
    consent_state: z.string(),
    viewport_w: z.number(),
    viewport_h: z.number(),
    screen_w: nonNegInt.optional(),
    screen_h: nonNegInt.optional(),
    visit_number: nonNegInt.optional(),
    exp: z.array(expTuple).max(100).optional(),
    items: z.array(z.unknown()).optional(),
    items_count: nonNegInt.optional(),
    purchase_type: z.enum(['initial', 'upsell']).optional(),
    parent_order_id: str.optional(),
    order_id: str.optional(),
    cart_id: str.optional(),
    currency: z.string().max(8).optional(),
    value_native: z.number().finite().optional(),
    utm_term: str.optional(),
    utm_content: str.optional(),
    entry_referrer: z.string().max(2048).optional(),
    entry_url: z.string().max(2048).optional(),
    entry_utm_source: str.optional(),
    entry_utm_medium: str.optional(),
    entry_utm_campaign: str.optional(),
    entry_utm_term: str.optional(),
    entry_utm_content: str.optional(),
    page_type: z.unknown().optional(),
    click_id_type: z.unknown().optional(),
    props: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  })
  .passthrough()
  .superRefine((e, ctx) => {
    if (e.purchase_type === 'upsell' && !e.parent_order_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['parent_order_id'],
        message: 'upsell requires parent_order_id',
      });
    }
  });

export type ValidationResult = { ok: true; event: PixelEvent } | { ok: false; reason: string };

const oneOf = <T extends string>(values: readonly T[], v: unknown): T | undefined =>
  typeof v === 'string' && (values as readonly string[]).includes(v) ? (v as T) : undefined;

/** Validate + normalise one raw pixel event. */
export function validateEvent(raw: unknown): ValidationResult {
  const parsed = eventSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      reason: `${issue?.path.join('.') || 'event'}: ${issue?.message ?? 'invalid'}`,
    };
  }
  const { page_type, click_id_type, items: rawItems, exp, ...e } = parsed.data;

  let items: Item[] | undefined;
  let truncated = false;
  if (rawItems !== undefined) {
    truncated = rawItems.length > MAX_ITEMS;
    const checked = z.array(itemSchema).safeParse(rawItems.slice(0, MAX_ITEMS));
    if (!checked.success) {
      const issue = checked.error.issues[0];
      return {
        ok: false,
        reason: `items.${issue?.path.join('.')}: ${issue?.message ?? 'invalid'}`,
      };
    }
    items = checked.data.map(
      (it) =>
        Object.fromEntries(
          Object.entries(it).filter(([, v]) => v !== undefined),
        ) as unknown as Item,
    );
  }

  const pageType = oneOf(PAGE_TYPES, page_type);
  const clickIdType = oneOf(CLICK_ID_TYPES, click_id_type);
  const props = truncated ? { ...(e.props ?? {}), _items_truncated: 1 } : e.props;
  const itemsCount =
    e.items_count ?? (items ? items.reduce((n, it) => n + (it.quantity ?? 1), 0) : undefined);

  const event = {
    ...e,
    event_name: e.event_name === 'checkout_start' ? 'begin_checkout' : e.event_name,
    screen_w: e.screen_w ?? 0,
    screen_h: e.screen_h ?? 0,
    exp: (exp ?? []).map((t): ExpSession => [t[0], t[1], t[2], (t as number[])[3] ?? 0]),
    ...(items === undefined ? {} : { items }),
    ...(itemsCount === undefined ? {} : { items_count: itemsCount }),
    ...(props === undefined ? {} : { props }),
    ...(pageType === undefined ? {} : { page_type: pageType }),
    ...(clickIdType === undefined ? {} : { click_id_type: clickIdType }),
  };
  return { ok: true, event: event as unknown as PixelEvent };
}
