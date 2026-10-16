/**
 * Simulated shop traffic for one A/B test on staging. Pure and seeded: the
 * same options give the same rows. Emits raw rows in the samples shape
 * (`scripts/e2e/prd006/raw.ts`), which `simToWire` turns into wire events.
 *
 * Per visitor: an `experiment_view` exposure, page views, custom events, and
 * with a per-variation probability the funnel add_to_cart → begin_checkout →
 * add_shipping_info → add_payment_info → purchase, plus upsells (15 %) and
 * thank-you-page reloads (3 %, same order id). 20 % come back on a later day,
 * 1 % are bots. Behaviour mirrors fixture F2 (`fixtures/f2-generator.ts`).
 */

import { uuidFor } from '../e2e/cross/shared/ids.ts';
import { seededRandom } from '../e2e/prd006/fixtures/f2-generator.ts';
import type { RawEvent, RawItem, Sim } from '../e2e/prd006/raw.ts';
import {
  CHANNELS,
  CITIES,
  DEVICES,
  PRODUCTS,
  UPSELL,
  type Weighted,
  pick,
} from './shop-catalog.ts';

export interface TrafficOptions {
  readonly projectId: number;
  readonly experimentId: number;
  /** Variation ids, control first. */
  readonly variations: readonly number[];
  readonly visitorsPerVariation: number;
  /** Exposures spread over the `days` days ending at `nowMs`. */
  readonly days: number;
  readonly nowMs: number;
  /** Funnel-entry multiplier per variation id (default 1). */
  readonly lift: Readonly<Record<number, number>>;
  readonly seed: number;
  /** Host used in page URLs, e.g. `staging-shop.testa-soft.tech`. */
  readonly domain: string;
}

/** Share of visitors who start the funnel at lift 1. */
const BASE_FUNNEL_RATE = 0.24;
const DAY_MS = 86_400_000;

type ExpTuple = readonly [number, number, number];

interface ItemLine {
  readonly item_id: string;
  readonly product_id: string;
  readonly item_name: string;
  readonly item_variant: string;
  readonly price: number | null;
  readonly quantity: number;
}

interface Visitor {
  readonly id: string;
  readonly variation: number;
  readonly dims: Readonly<Record<string, string | number>>;
  readonly bot: boolean;
}

const chTs = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');

export function validateOptions(o: TrafficOptions): void {
  if (o.variations.length < 2) throw new RangeError('need at least two variations (control first)');
  if (new Set(o.variations).size !== o.variations.length)
    throw new RangeError('duplicate variation ids');
  if (!Number.isInteger(o.visitorsPerVariation) || o.visitorsPerVariation < 1)
    throw new RangeError('visitorsPerVariation must be a positive integer');
  if (!Number.isInteger(o.days) || o.days < 1 || o.days > 60)
    throw new RangeError('days must be 1–60');
  for (const [id, m] of Object.entries(o.lift)) {
    if (!o.variations.includes(Number(id)))
      throw new RangeError(`lift for unknown variation ${id}`);
    if (!(m > 0 && m * BASE_FUNNEL_RATE < 1))
      throw new RangeError(`lift ${m} for ${id} out of range`);
  }
}

export function generateTraffic(o: TrafficOptions): Sim {
  validateOptions(o);
  const rand = seededRandom(o.seed);
  const events: RawEvent[] = [];
  const items: RawItem[] = [];
  const start = o.nowMs - o.days * DAY_MS;
  // Leave room after the last exposure for its session (≤ ~30 min of events).
  const span = o.days * DAY_MS - 3_600_000;

  const add = (
    v: Visitor,
    ms: number,
    name: string,
    exp: readonly ExpTuple[],
    sid: string,
    extra: Partial<RawEvent> = {},
    lines: readonly ItemLine[] = [],
  ): RawEvent => {
    const row = {
      ...v.dims,
      event_id: uuidFor(`stg|${o.seed}|${v.id}|${name}|${ms}|${String(extra.order_id ?? '')}`),
      client_ts: chTs(ms),
      server_ts: chTs(ms + 180),
      project_id: o.projectId,
      experiment_id: null,
      variation_id: null,
      visitor_id: v.id,
      session_id: sid,
      event_name: name,
      url: `https://${o.domain}/${name === 'page_view' ? '' : name}`,
      referrer: '',
      is_bot: v.bot ? 1 : 0,
      in_experiment: exp.length > 0 ? 1 : 0,
      consent_state: 'granted',
      tracker_version: 'staging-sim',
      exp_ids: exp.map((e) => e[0]),
      exp_var_ids: exp.map((e) => e[1]),
      exp_session_starts: exp.map((e) => e[2]),
      goal_id: 0,
      value_native: 0,
      currency: '',
      order_id: '',
      items_count: lines.reduce((s, l) => s + l.quantity, 0),
      purchase_type: '',
      parent_order_id: '',
      page_type: '',
      cart_id: '',
      props: {},
      ...extra,
    } as RawEvent;
    events.push(row);
    for (const l of lines) {
      items.push({
        ...l,
        event_id: row.event_id,
        client_ts: row.client_ts,
        project_id: o.projectId,
        visitor_id: v.id,
        session_id: sid,
        event_name: name,
        exp_ids: row.exp_ids,
        order_id: row.order_id,
        purchase_type: row.purchase_type,
        currency: row.currency || 'EUR',
        discount: 0,
        position: 0,
      } as RawItem);
    }
    return row;
  };

  let n = 0;
  for (const variation of o.variations) {
    for (let k = 0; k < o.visitorsPerVariation; k++) {
      n += 1;
      visit(makeVisitor(n, variation), start + Math.floor(rand() * span));
    }
  }
  return { events, items };

  function makeVisitor(n: number, variation: number): Visitor {
    const [city, region, country] = pick(rand, CITIES);
    const device = pick(rand, DEVICES);
    const [channel, src, medium, refDomain, clickId] = pick(rand, CHANNELS);
    const desktop = device === 'desktop';
    const [osName, osVer, browser] = desktop
      ? rand() < 0.55
        ? ['Windows', '11', 'Chrome']
        : ['macOS', '14.5', rand() < 0.5 ? 'Safari' : 'Chrome']
      : rand() < 0.55
        ? ['iOS', '18.0', 'Safari']
        : ['Android', '15', 'Chrome'];
    return {
      id: `stg${o.seed}v${String(n).padStart(6, '0')}`,
      variation,
      bot: rand() < 0.01,
      dims: {
        country,
        region,
        region_subdivision: region,
        city,
        device_type: device,
        browser,
        os: `${osName} ${osVer}`,
        os_name: osName,
        os_version: osVer,
        browser_name: browser,
        browser_version: browser === 'Chrome' ? '129' : '18',
        viewport_w: desktop ? 1440 : 390,
        viewport_h: desktop ? 900 : 664,
        screen_w: desktop ? 1920 : 390,
        screen_h: desktop ? 1080 : 844,
        channel,
        referrer_domain: refDomain,
        click_id_type: clickId,
        utm_source: '',
        utm_medium: '',
        utm_campaign: '',
        utm_term: '',
        utm_content: '',
        entry_referrer: refDomain === '(direct)' ? '' : `https://${refDomain}/`,
        entry_url: `https://${o.domain}/${src ? `?utm_source=${src}` : ''}`,
        entry_utm_source: src,
        entry_utm_medium: medium,
        entry_utm_campaign: src ? 'autumn_sale' : '',
        entry_utm_term: '',
        entry_utm_content: '',
        visit_number: rand() < 0.7 ? 1 : 2 + Math.floor(rand() * 4),
      },
    };
  }

  function visit(v: Visitor, first: number): void {
    const visits = [first];
    const comeBack = first + (1 + Math.floor(rand() * 3)) * DAY_MS;
    if (rand() < 0.2 && comeBack < o.nowMs - 3_600_000) visits.push(comeBack);
    for (const [vi, t0] of visits.entries()) session(v, vi, t0);
  }

  function session(v: Visitor, vi: number, t0: number): void {
    const sid = `stgs-${v.id}-${vi}`;
    const exp: readonly ExpTuple[] = [[o.experimentId, v.variation, Math.floor(t0 / 1000)]];
    add(v, t0, 'experiment_view', exp, sid, {
      experiment_id: o.experimentId,
      variation_id: v.variation,
    });
    let t = t0;
    const next = (minS: number, spreadS: number) => {
      t += (minS + Math.floor(rand() * spreadS)) * 1000;
      return t;
    };
    const pages = 1 + Math.floor(-Math.log(1 - rand()) * 2);
    for (let p = 0; p < pages; p++)
      add(v, next(15, 120), 'page_view', exp, sid, { url: `https://${o.domain}/p${p}` });
    if (rand() < 0.03)
      add(v, next(30, 1), 'generate_lead', exp, sid, { props: { lead_type: 'newsletter' } });
    if (rand() < 0.01) add(v, next(30, 1), 'sign_up', exp, sid);
    if (rand() >= BASE_FUNNEL_RATE * (o.lift[v.variation] ?? 1)) return;
    funnel(v, vi, exp, sid, () => next(30, 60));
  }

  function funnel(
    v: Visitor,
    vi: number,
    exp: readonly ExpTuple[],
    sid: string,
    next: () => number,
  ): void {
    const lines = cartLines();
    const currency = rand() < 0.75 ? 'EUR' : rand() < 0.6 ? 'USD' : 'GBP';
    const value = lines.reduce((s, l) => s + (l.price ?? 0) * l.quantity, 0);
    add(v, next(), 'add_to_cart', exp, sid, { value_native: value, currency }, lines);
    if (rand() > 0.6) return;
    add(v, next(), 'begin_checkout', exp, sid, { value_native: value, currency });
    if (rand() > 0.8) return;
    add(v, next(), 'add_shipping_info', exp, sid);
    if (rand() > 0.85) return;
    const payment = pick(rand, [
      ['card', 0.55],
      ['paypal', 0.25],
      ['apple_pay', 0.15],
      ['klarna', 0.05],
    ] as const satisfies readonly Weighted<string>[]);
    const coupon =
      rand() < 0.2 ? (['WELCOME10', 'FREESHIP', 'AUTUMN15'][Math.floor(rand() * 3)] ?? '') : '';
    const props = { payment_type: payment, ...(coupon ? { coupon } : {}) };
    add(v, next(), 'add_payment_info', exp, sid, { props });
    if (rand() > 0.8) return;
    const orderId = `STG-${o.seed}-${v.id}-${vi}`;
    const paid = Math.round(value * (coupon === 'WELCOME10' ? 0.9 : 1) * 100) / 100;
    const at = next();
    const order = {
      order_id: orderId,
      value_native: paid,
      currency,
      purchase_type: 'initial',
      props,
    };
    add(v, at, 'purchase', exp, sid, order, lines);
    // Thank-you page reload: same order id, its own event id; dedup must drop it.
    if (rand() < 0.03) add(v, at + 9_000, 'purchase', exp, sid, order, lines);
    if (rand() < 0.15) {
      const [pid, name, price] = UPSELL;
      add(
        v,
        next(),
        'purchase',
        exp,
        sid,
        {
          order_id: `${orderId}-U1`,
          parent_order_id: orderId,
          purchase_type: 'upsell',
          value_native: price,
          currency,
        },
        [
          {
            item_id: pid,
            product_id: pid,
            item_name: name,
            item_variant: 'Default',
            price,
            quantity: 1,
          },
        ],
      );
    }
  }

  function cartLines(): ItemLine[] {
    return Array.from({ length: rand() < 0.3 ? 2 : 1 }, () => {
      const [pid, name, price, variants] =
        PRODUCTS[Math.min(Math.floor(-Math.log(1 - rand()) * 1.8), PRODUCTS.length - 1)] ??
        PRODUCTS[0];
      const variant = variants[Math.floor(rand() * variants.length)] ?? 'Default';
      return {
        item_id: `${pid}-${variant.replace(/[ /.]/g, '')}`,
        product_id: pid,
        item_name: name,
        item_variant: variant,
        price: rand() < 0.05 ? null : price,
        quantity: rand() < 0.15 ? 2 : 1,
      };
    });
  }
}
