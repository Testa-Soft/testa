/**
 * Fixture F2 (006-validation.md "Fixture F2 — generated (oracle), shop"):
 * seeded (`seed = 1717`), 2 experiments × 3 variations, 7 days, ≈ 20,000
 * visitors, 25 cities, every channel rule. Funnel behaviour: repeat sessions
 * (20% return, so session_idx reaches 2+), reload duplicates (3% of
 * purchases), upsells (15%), USD / EUR / GBP purchases, events outside
 * sessions (2%, sent with an empty `exp`), contaminated visitors (0.5%) and
 * bots (1%). 40% of visitors are in both experiments (two `exp` tuples).
 *
 * Emits raw rows (`raw.ts`, the shape of docs/reference/samples raw files):
 * the oracle models them in memory and `ingest.ts` sends them as wire events.
 */

import { uuidFor } from '../../cross/shared/ids.ts';
import type { RawEvent, RawItem, Sim } from '../raw.ts';

export const F2_SEED = 1717;
export const F2_DAYS = 7;
export const F2_FROM = '2026-10-01';
export const F2_TO = '2026-10-07';
export const F2_VISITORS_PER_DAY = 2_860;

/** mulberry32: small, seeded, deterministic. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

type Weighted<T> = readonly [T, number];

const CITIES: readonly Weighted<readonly [string, string, string]>[] = [
  ['Vilnius', 'Vilnius County', 'LT'],
  ['Kaunas', 'Kaunas County', 'LT'],
  ['Klaipėda', 'Klaipėda County', 'LT'],
  ['Riga', 'Riga', 'LV'],
  ['Tallinn', 'Harju County', 'EE'],
  ['Warsaw', 'Masovia', 'PL'],
  ['Kraków', 'Lesser Poland', 'PL'],
  ['Berlin', 'Berlin', 'DE'],
  ['Munich', 'Bavaria', 'DE'],
  ['Hamburg', 'Hamburg', 'DE'],
  ['London', 'England', 'GB'],
  ['Manchester', 'England', 'GB'],
  ['Dublin', 'Leinster', 'IE'],
  ['Paris', 'Île-de-France', 'FR'],
  ['Lyon', 'Auvergne-Rhône-Alpes', 'FR'],
  ['Madrid', 'Madrid', 'ES'],
  ['Barcelona', 'Catalonia', 'ES'],
  ['Rome', 'Lazio', 'IT'],
  ['Milan', 'Lombardy', 'IT'],
  ['Amsterdam', 'North Holland', 'NL'],
  ['Stockholm', 'Stockholm', 'SE'],
  ['Oslo', 'Oslo', 'NO'],
  ['Helsinki', 'Uusimaa', 'FI'],
  ['New York', 'New York', 'US'],
  ['Toronto', 'Ontario', 'CA'],
].map((c, i) => [c as unknown as readonly [string, string, string], 1 / (i + 2)] as const);

const DEVICES: readonly Weighted<string>[] = [
  ['desktop', 0.45],
  ['mobile', 0.47],
  ['tablet', 0.08],
];

/** Channel → [entry utm source, medium, referrer domain, click id type]. */
const CHANNELS: readonly Weighted<readonly [string, string, string, string, string]>[] = [
  [['Direct', '', '', '(direct)', ''], 0.28],
  [['Organic Search', '', '', 'google.com', ''], 0.22],
  [['Paid Search', 'google', 'cpc', 'google.com', 'gclid'], 0.16],
  [['Paid Social', 'facebook', 'paid_social', 'facebook.com', 'fbclid'], 0.12],
  [['Email', 'newsletter', 'email', '(direct)', ''], 0.1],
  [['Referral', '', '', 'blog.runners.example', ''], 0.12],
];

const PRODUCTS = [
  ['P-RUN', 'Trail Runner', 89, ['Black / US 9', 'Black / US 10', 'White / US 9', 'White / US 10']],
  ['P-JKT', 'Rain Jacket', 149, ['S', 'M', 'L']],
  ['P-TEE', 'Merino Tee', 39, ['S', 'M', 'L']],
  ['P-SOX', 'Wool Socks 3-pack', 19, ['M', 'L']],
  ['P-BAG', 'Day Pack', 69, ['Grey', 'Navy']],
  ['P-BTL', 'Steel Bottle', 29, ['0.5 l', '0.75 l']],
] as const;
const UPSELL = ['P-CARE', 'Shoe Care Kit', 18] as const;

export const F2_EXPERIMENTS = [
  { id: 2001, variations: [300, 301, 302] },
  { id: 2002, variations: [400, 401, 402] },
] as const;

function pick<T>(rand: () => number, options: readonly Weighted<T>[]): T {
  const total = options.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [value, w] of options) {
    r -= w;
    if (r <= 0) return value;
  }
  return (options.at(-1) as Weighted<T>)[0];
}

const chTs = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');

/** One cart / order line before it becomes an `event_items` row. */
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
  readonly dims: Record<string, string | number>;
  readonly bot: boolean;
}

export interface F2Options {
  readonly seed?: number;
  readonly days?: number;
  readonly visitorsPerDay?: number;
}

/** F2 by default; V10 scales it (`days: 14`, 200k visitors). */
export function generateF2(projectId: number, opts: F2Options = {}): Sim {
  const seed = opts.seed ?? F2_SEED;
  const days = opts.days ?? F2_DAYS;
  const perDay = opts.visitorsPerDay ?? F2_VISITORS_PER_DAY;
  const rand = seededRandom(seed);
  const events: RawEvent[] = [];
  const items: RawItem[] = [];

  const add = (
    v: Visitor,
    ms: number,
    name: string,
    exp: readonly (readonly [number, number, number])[],
    sid: string,
    extra: Partial<RawEvent> = {},
    lines: readonly ItemLine[] = [],
  ): RawEvent => {
    const row: RawEvent = {
      ...v.dims,
      event_id: uuidFor(`f2|${v.id}|${name}|${ms}|${String(extra.order_id ?? '')}`),
      client_ts: chTs(ms),
      server_ts: chTs(ms + 180),
      project_id: projectId,
      experiment_id: null,
      variation_id: null,
      visitor_id: v.id,
      session_id: sid,
      event_name: name,
      url: `https://shop.example/${name}`,
      referrer: '',
      is_bot: v.bot ? 1 : 0,
      in_experiment: exp.length > 0 ? 1 : 0,
      consent_state: 'granted',
      tracker_version: '4.1.0',
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
        project_id: projectId,
        visitor_id: v.id,
        session_id: sid,
        event_name: name,
        exp_ids: row.exp_ids,
        order_id: row.order_id,
        purchase_type: row.purchase_type,
        currency: row.currency || 'EUR',
        discount: 0,
        position: 0,
      });
    }
    return row;
  };

  let n = 0;
  for (let day = 0; day < days; day++) {
    for (let k = 0; k < perDay; k++) {
      n += 1;
      visit(day, n);
    }
  }
  return { events, items };

  function visit(day: number, n: number): void {
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
    const v: Visitor = {
      id: `f2v${String(n).padStart(6, '0')}`,
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
        entry_url: `https://shop.example/${src ? `?utm_source=${src}` : ''}`,
        entry_utm_source: src,
        entry_utm_medium: medium,
        entry_utm_campaign: src ? 'autumn_sale' : '',
        entry_utm_term: '',
        entry_utm_content: '',
        visit_number: rand() < 0.7 ? 1 : 2 + Math.floor(rand() * 4),
      },
    };
    const varA = F2_EXPERIMENTS[0].variations[Math.floor(rand() * 3)] as number;
    const varB =
      rand() < 0.4 ? (F2_EXPERIMENTS[1].variations[Math.floor(rand() * 3)] as number) : null;
    const first =
      Date.parse(`${F2_FROM}T00:00:00Z`) +
      day * 86_400_000 +
      (7 + Math.floor(rand() * 15)) * 3_600_000 +
      Math.floor(rand() * 3_600_000);
    const visits = [first];
    if (rand() < 0.2 && day < days - 1)
      visits.push(first + (1 + Math.floor(rand() * (days - 1 - day))) * 86_400_000);
    const contaminated = rand() < 0.005;
    for (const [vi, t0] of visits.entries())
      session(v, n, vi, t0, varA, varB, contaminated && vi === 0);
    if (rand() < 0.02) {
      const last = visits.at(-1) as number;
      add(v, last + 2 * 3_600_000, 'page_view', [], `f2s-${v.id}-late`);
    }
  }

  function session(
    v: Visitor,
    n: number,
    vi: number,
    t0: number,
    varA: number,
    varB: number | null,
    contaminate: boolean,
  ): void {
    const sid = `f2s-${v.id}-${vi}`;
    const s = Math.floor(t0 / 1000);
    const exp: (readonly [number, number, number])[] = [[2001, varA, s]];
    if (varB !== null) exp.push([2002, varB, s]);
    add(v, t0, 'experiment_view', exp, sid, { experiment_id: 2001, variation_id: varA });
    if (varB !== null)
      add(v, t0 + 50, 'experiment_view', exp, sid, { experiment_id: 2002, variation_id: varB });
    if (contaminate) {
      const alt = F2_EXPERIMENTS[0].variations[
        (F2_EXPERIMENTS[0].variations.indexOf(varA as 300) + 1) % 3
      ] as number;
      add(v, t0 + 180_000, 'experiment_view', [[2001, alt, s]], sid, {
        experiment_id: 2001,
        variation_id: alt,
      });
    }
    let t = t0;
    const pages = 1 + Math.floor(-Math.log(1 - rand()) * 2);
    for (let p = 0; p < pages; p++) {
      t += (15 + Math.floor(rand() * 120)) * 1000;
      add(v, t, 'page_view', exp, sid, { url: `https://shop.example/p${p}` });
    }
    custom(v, exp, sid, () => {
      t += 30_000;
      return t;
    });
    const lift = { 300: 1, 301: 1.15, 302: 0.95, 400: 1, 401: 1.05, 402: 1.1 } as Record<
      number,
      number
    >;
    if (rand() >= 0.24 * (lift[varA] ?? 1)) return;
    funnel(v, n, vi, exp, sid, () => {
      t += (30 + Math.floor(rand() * 60)) * 1000;
      return t;
    });
  }

  function custom(
    v: Visitor,
    exp: (readonly [number, number, number])[],
    sid: string,
    next: () => number,
  ): void {
    if (rand() < 0.05) add(v, next(), 'size_guide_opened', exp, sid, { props: { source: 'pdp' } });
    if (rand() < 0.04) add(v, next(), 'video_played', exp, sid, { props: { video: 'fit' } });
    if (rand() < 0.03) add(v, next(), 'review_opened', exp, sid);
    if (rand() < 0.03)
      add(v, next(), 'generate_lead', exp, sid, { props: { lead_type: 'newsletter' } });
    if (rand() < 0.01) add(v, next(), 'sign_up', exp, sid);
    for (const goal of [12, 13, 14])
      if (rand() < 0.06) add(v, next(), 'conversion', exp, sid, { goal_id: goal });
  }

  function funnel(
    v: Visitor,
    n: number,
    vi: number,
    exp: (readonly [number, number, number])[],
    sid: string,
    next: () => number,
  ): void {
    const lines = Array.from({ length: rand() < 0.3 ? 2 : 1 }, () => {
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
    ] as const);
    const coupon =
      rand() < 0.2 ? (['WELCOME10', 'FREESHIP', 'AUTUMN15'][Math.floor(rand() * 3)] ?? '') : '';
    add(v, next(), 'add_payment_info', exp, sid, {
      props: { payment_type: payment, ...(coupon ? { coupon } : {}) },
    });
    if (rand() > 0.8) return;
    const orderId = `F2-${n}-${vi}`;
    const paid = Math.round(value * (coupon === 'WELCOME10' ? 0.9 : 1) * 100) / 100;
    const props = { payment_type: payment, ...(coupon ? { coupon } : {}) };
    const at = next();
    const purchase = add(
      v,
      at,
      'purchase',
      exp,
      sid,
      { order_id: orderId, value_native: paid, currency, purchase_type: 'initial', props },
      lines,
    );
    if (rand() < 0.03) {
      // Thank-you page reload: same order, its own event id, 9 s later.
      const { event_id: _id, client_ts: _c, server_ts: _s, ...order } = purchase;
      add(
        v,
        at + 9_000,
        'purchase',
        exp,
        sid,
        { ...order, event_id: uuidFor(`f2|reload|${orderId}`) },
        lines,
      );
    }
    if (rand() < 0.15) {
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
          value_native: UPSELL[2],
          currency,
        },
        [
          {
            item_id: UPSELL[0],
            product_id: UPSELL[0],
            item_name: UPSELL[1],
            item_variant: 'Default',
            price: UPSELL[2],
            quantity: 1,
          },
        ],
      );
    }
  }
}
