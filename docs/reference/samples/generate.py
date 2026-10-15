"""PRD-006 sample data generator.

Produces, from ONE set of simulated raw events:
  raw/      what ClickHouse stores (events, event_items rows; exposures as the merged view)
  modeled/  what the collector APIs return (report, products, distributions, health)

Two datasets:
  f1    the hand-computed fixture from docs/prds/006-validation.md (tiny; asserts the hand values)
  demo  a realistic 14-day test, 3 variations, ~4k visitors (for frontend fakes)

Run:  python3 docs/reference/samples/generate.py      (needs numpy)
The modelling code here is a reference ORACLE of PRD-006 §2.1, §5.1, §5.4, §6.2–6.5.
"""
import json, math, os, random, hashlib
from collections import defaultdict
from datetime import datetime, timedelta, timezone

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
FX = {"EUR": 1.0, "USD": 0.9, "GBP": 1.15}
PROJECT = 42
STEPS = ["add_to_cart", "begin_checkout", "add_shipping_info", "add_payment_info", "purchase"]
UTC = timezone.utc


def ts(dt):
    return dt.strftime("%Y-%m-%d %H:%M:%S.") + f"{dt.microsecond // 1000:03d}"


def uuid_for(*parts):
    h = hashlib.sha1("|".join(map(str, parts)).encode()).hexdigest()
    return f"{h[:8]}-{h[8:12]}-7{h[13:16]}-{'8' + h[17:20]}-{h[20:32]}"


# ─────────────────────────── raw row builders ───────────────────────────

class Visitor:
    def __init__(self, vid, dims, bot=False):
        self.vid, self.dims, self.bot = vid, dims, bot
        self.sessions = []        # list of (exp_id, var_id, session_start_dt)
        self.visit_number = 0


def base_row(v, dt, event_name, url, exp, browsing_sid):
    d = v.dims
    return {
        "event_id": uuid_for(v.vid, event_name, dt.isoformat(), url),
        "client_ts": ts(dt), "server_ts": ts(dt + timedelta(milliseconds=180)),
        "project_id": PROJECT, "experiment_id": None, "variation_id": None,
        "visitor_id": v.vid, "session_id": browsing_sid, "event_name": event_name,
        "url": url, "referrer": "",
        "country": d["country"], "region": d["region"], "region_subdivision": d["region"], "city": d["city"],
        "device_type": d["device_type"], "browser": d["browser_name"], "os": f'{d["os_name"]} {d["os_version"]}',
        "os_name": d["os_name"], "os_version": d["os_version"],
        "browser_name": d["browser_name"], "browser_version": d["browser_version"],
        "viewport_w": d["viewport"][0], "viewport_h": d["viewport"][1],
        "screen_w": d["screen"][0], "screen_h": d["screen"][1],
        "tracker_version": "4.1.0", "is_bot": 1 if v.bot else 0,
        "in_experiment": 1 if exp else 0, "consent_state": "granted",
        "utm_source": "", "utm_medium": "", "utm_campaign": "", "utm_term": "", "utm_content": "",
        "entry_referrer": "", "entry_url": "", "entry_utm_source": "", "entry_utm_medium": "",
        "entry_utm_campaign": "", "entry_utm_term": "", "entry_utm_content": "", "click_id_type": "",
        "referrer_domain": "", "channel": "",
        "visit_number": v.visit_number,
        "exp_ids": [e[0] for e in exp], "exp_var_ids": [e[1] for e in exp], "exp_session_starts": [e[2] for e in exp],
        "goal_id": 0, "value_native": 0, "currency": "", "order_id": "", "items_count": 0,
        "purchase_type": "", "parent_order_id": "", "page_type": "", "cart_id": "",
        "props": {},
    }


class Sim:
    def __init__(self):
        self.events, self.items = [], []

    def add(self, row, items=None):
        if items:
            row["items_count"] = sum(i["quantity"] for i in items)
            for i in items:
                self.items.append({
                    "event_id": row["event_id"], "client_ts": row["client_ts"], "project_id": PROJECT,
                    "visitor_id": row["visitor_id"], "session_id": row["session_id"], "event_name": row["event_name"],
                    "exp_ids": row["exp_ids"], "order_id": row["order_id"], "purchase_type": row["purchase_type"],
                    "currency": row["currency"] or "EUR",
                    "item_id": i["item_id"], "product_id": i.get("product_id", i["item_id"]),
                    "item_name": i.get("item_name", ""), "item_variant": i.get("item_variant", ""),
                    "item_brand": i.get("item_brand", ""), "item_category": i.get("item_category", ""),
                    "item_category2": "", "item_category3": "",
                    "price": i.get("price"), "quantity": i["quantity"], "discount": 0, "item_list_name": "", "position": 0,
                })
        self.events.append(row)
        return row


# ─────────────────────────── F1 fixture (hand-computed) ───────────────────────────

def build_f1():
    sim = Sim()
    D1, D2, D3 = (datetime(2026, 10, d, tzinfo=UTC) for d in (1, 2, 3))
    dims = dict(country="LT", region="Vilnius County", city="Vilnius", device_type="desktop", os_name="macOS",
                os_version="14.5", browser_name="Chrome", browser_version="129", viewport=(1440, 900), screen=(1512, 982))

    def at(day, h, m):
        return day + timedelta(hours=h, minutes=m)

    def expv(sim, v, dt, e, var, sid):
        v.visit_number += 1
        s = int(dt.timestamp())
        r = base_row(v, dt, "experiment_view", "https://shop.example/product/a", [[e, var, s]], sid)
        r.update(experiment_id=e, variation_id=var, entry_url="https://shop.example/", channel="Direct",
                 referrer_domain="(direct)")
        sim.add(r)
        return [[e, var, s]]

    def ev(sim, v, dt, name, exp, sid, **kw):
        items = kw.pop("items", None)
        props = kw.pop("props", {})
        r = base_row(v, dt, name, kw.pop("url", "https://shop.example/checkout"), exp, sid)
        r.update(kw)
        r["props"] = props
        return sim.add(r, items)

    A = lambda q, p: {"item_id": "SKU-A", "product_id": "SKU-A", "item_name": "Product A", "item_variant": "Default", "price": p, "quantity": q}
    # v1
    v = Visitor("v1", dims); x = expv(sim, v, at(D1, 10, 0), 1717, 100, "s-v1")
    ev(sim, v, at(D1, 10, 5), "add_to_cart", x, "s-v1", items=[A(2, 50)], value_native=100, currency="EUR")
    ev(sim, v, at(D1, 10, 7), "begin_checkout", x, "s-v1")
    ev(sim, v, at(D1, 10, 8), "add_shipping_info", x, "s-v1")
    ev(sim, v, at(D1, 10, 9), "add_payment_info", x, "s-v1", props={"payment_type": "card"})
    ev(sim, v, at(D1, 10, 10), "purchase", x, "s-v1", order_id="O1", value_native=100, currency="EUR", purchase_type="initial", items=[A(2, 50)], props={"payment_type": "card"})
    ev(sim, v, at(D1, 10, 11), "purchase", x, "s-v1", order_id="O1", value_native=100, currency="EUR", purchase_type="initial", items=[A(2, 50)], props={"payment_type": "card"})
    # v2
    v = Visitor("v2", dims); x = expv(sim, v, at(D1, 11, 0), 1717, 101, "s-v2")
    ev(sim, v, at(D1, 11, 8), "add_payment_info", x, "s-v2", props={"payment_type": "paypal"})
    ev(sim, v, at(D1, 11, 10), "purchase", x, "s-v2", order_id="O2", value_native=50, currency="USD", purchase_type="initial",
       items=[{"item_id": "SKU-B", "product_id": "SKU-B", "item_name": "Product B", "item_variant": "Default", "price": 50, "quantity": 1}], props={"coupon": "WELCOME10", "payment_type": "paypal"})
    ev(sim, v, at(D1, 11, 12), "purchase", x, "s-v2", order_id="O2-U1", value_native=20, currency="EUR", purchase_type="upsell", parent_order_id="O2",
       items=[{"item_id": "SKU-U", "product_id": "SKU-U", "item_name": "Upsell U", "item_variant": "Default", "price": 20, "quantity": 1}])
    # v3
    v = Visitor("v3", dims); expv(sim, v, at(D1, 12, 0), 1717, 101, "s-v3a")
    x = expv(sim, v, at(D3, 9, 0), 1717, 101, "s-v3b")
    ev(sim, v, at(D3, 9, 20), "purchase", x, "s-v3b", order_id="O3", value_native=80, currency="EUR", purchase_type="initial", items=[A(2, 40)])
    # v4 contaminated
    v = Visitor("v4", dims); expv(sim, v, at(D1, 13, 0), 1717, 100, "s-v4"); x = expv(sim, v, at(D1, 13, 30), 1717, 101, "s-v4")
    ev(sim, v, at(D1, 13, 40), "purchase", x, "s-v4", order_id="O4", value_native=999, currency="EUR", purchase_type="initial", items=[A(1, 999)])
    # v5 other experiment
    v = Visitor("v5", dims); x = expv(sim, v, at(D1, 14, 0), 1802, 200, "s-v5")
    ev(sim, v, at(D1, 14, 10), "purchase", x, "s-v5", order_id="O5", value_native=60, currency="EUR", purchase_type="initial", items=[A(1, 60)])
    # v6 empty exp
    v = Visitor("v6", dims); expv(sim, v, at(D2, 10, 0), 1717, 100, "s-v6")
    ev(sim, v, at(D2, 10, 30), "purchase", [], "s-v6", order_id="O6", value_native=70, currency="EUR", purchase_type="initial", items=[A(1, 70)])
    # v7 lead / custom / goal
    v = Visitor("v7", dims); x = expv(sim, v, at(D2, 11, 0), 1717, 100, "s-v7")
    ev(sim, v, at(D2, 11, 5), "generate_lead", x, "s-v7", props={"lead_type": "quote"})
    ev(sim, v, at(D2, 11, 6), "size_guide_opened", x, "s-v7", props={"source": "pdp"})
    ev(sim, v, at(D2, 11, 7), "conversion", x, "s-v7", goal_id=12)
    # v8 mismatch + missing price
    v = Visitor("v8", dims); expv(sim, v, at(D2, 12, 0), 1717, 101, "s-v8")
    ev(sim, v, at(D2, 12, 5), "add_to_cart", [[1717, 100, int(at(D2, 12, 0).timestamp())]], "s-v8",
       items=[{"item_id": "SKU-C", "product_id": "SKU-C", "item_name": "Product C", "item_variant": "Default", "price": None, "quantity": 1}])
    # v9 bot
    v = Visitor("v9", dims, bot=True); x = expv(sim, v, at(D1, 15, 0), 1717, 100, "s-v9")
    ev(sim, v, at(D1, 15, 5), "purchase", x, "s-v9", order_id="O9", value_native=500, currency="EUR", purchase_type="initial", items=[A(1, 500)])
    return sim


# ─────────────────────────── demo dataset ───────────────────────────

DEVICES = [("mobile", .60), ("desktop", .34), ("tablet", .06)]
CHANNELS = [("Paid Search", .26), ("Organic Search", .24), ("Paid Social", .20), ("Direct", .14), ("Email", .10), ("Referral", .06)]
COUNTRIES = [("LT", "Vilnius County", "Vilnius", .30), ("LV", "Riga", "Riga", .18), ("EE", "Harju", "Tallinn", .14),
             ("PL", "Mazowieckie", "Warsaw", .12), ("DE", "Berlin", "Berlin", .10), ("FI", "Uusimaa", "Helsinki", .06),
             ("SE", "Stockholm", "Stockholm", .04), ("NO", "Oslo", "Oslo", .03), ("DK", "Capital", "Copenhagen", .02), ("GB", "England", "London", .01)]
PRODUCTS = [
    ("P-RUN", "Trail Runner", 89.0, [("Black / US 10", .38), ("Black / US 9", .24), ("White / US 10", .21), ("White / US 9", .17)]),
    ("P-TEE", "Merino Tee", 39.0, [("M", .44), ("L", .35), ("S", .21)]),
    ("P-SOX", "Wool Socks 3-pack", 19.0, [("M", .55), ("L", .45)]),
    ("P-JKT", "Rain Jacket", 149.0, [("Navy / M", .40), ("Navy / L", .32), ("Olive / M", .28)]),
    ("P-CAP", "Logo Cap", 24.0, [("One size", 1.0)]),
    ("P-BTL", "Steel Bottle", 29.0, [("750 ml", .6), ("500 ml", .4)]),
    ("P-BAG", "Day Pack", 69.0, [("Black", .7), ("Grey", .3)]),
    ("P-GLV", "Running Gloves", 22.0, [("S/M", .55), ("L/XL", .45)]),
    ("P-BND", "Headband", 12.0, [("One size", 1.0)]),
    ("P-LCE", "Spare Laces", 6.0, [("Black", .6), ("White", .4)]),
]
UPSELL = ("P-CARE", "Shoe Care Kit", 18.0)


def pick(rng, opts, k=-1):
    r, a = rng.random(), 0.0
    for o in opts:
        a += o[k]
        if r <= a:
            return o
    return opts[-1]


def build_demo(seed=1717):
    rng = random.Random(seed)
    sim = Sim()
    start = datetime(2026, 10, 1, tzinfo=UTC)
    VARS = [100, 101, 102]
    LIFT = {100: 1.0, 101: 1.15, 102: 0.96}
    vid_n = 0
    for day in range(14):
        for var in VARS:
            n = int(rng.gauss(95, 8) * (1.15 if (start + timedelta(days=day)).weekday() >= 5 else 1))
            for _ in range(n):
                vid_n += 1
                c = pick(rng, COUNTRIES)
                dev = pick(rng, DEVICES, 1)[0]
                os_name, os_ver, br = (("iOS", "18.0", "Safari") if rng.random() < .55 else ("Android", "15", "Chrome")) if dev != "desktop" else \
                    (("Windows", "11", "Chrome") if rng.random() < .55 else ("macOS", "14.5", rng.choice(["Chrome", "Safari", "Firefox", "Edge"])))
                ch = pick(rng, CHANNELS, 1)[0]
                dims = dict(country=c[0], region=c[1], city=c[2], device_type=dev, os_name=os_name, os_version=os_ver,
                            browser_name=br, browser_version="129" if br == "Chrome" else "18", channel=ch,
                            viewport=(390, 664) if dev == "mobile" else ((820, 1100) if dev == "tablet" else (1440, 900)),
                            screen=(390, 844) if dev == "mobile" else ((820, 1180) if dev == "tablet" else rng.choice([(1920, 1080), (1512, 982), (2560, 1440)])))
                v = Visitor(f"v_{seed}_{vid_n:05d}", dims, bot=rng.random() < 0.01)
                v.visit_number = 1 if rng.random() < .68 else rng.randint(2, 6)
                first = start + timedelta(days=day, hours=rng.randint(7, 22), minutes=rng.randint(0, 59), seconds=rng.randint(0, 59))
                visits = [first]
                if rng.random() < .2 and day < 13:
                    visits.append(first + timedelta(days=rng.randint(1, min(4, 13 - day)), hours=rng.randint(0, 5)))
                contaminated = rng.random() < 0.004
                b = {"desktop": 1.4, "mobile": .85, "tablet": 1.0}[dev] * {"Email": 1.8, "Direct": 1.3, "Organic Search": 1.0, "Paid Search": 1.1, "Paid Social": .6, "Referral": .9}[ch]
                bought_orders = 0
                for vi, vt in enumerate(visits):
                    sid = f"s_{v.vid}_{vi}"
                    s = int(vt.timestamp())
                    exp = [[1717, var, s]]
                    utm = {"Paid Search": ("google", "cpc"), "Paid Social": ("facebook", "paid_social"), "Email": ("newsletter", "email")}.get(ch, ("", ""))
                    r = base_row(v, vt, "experiment_view", "https://shop.example/product/trail-runner", exp, sid)
                    r.update(experiment_id=1717, variation_id=var, channel=ch, entry_url="https://shop.example/" + ("?utm_source=" + utm[0] if utm[0] else ""),
                             entry_utm_source=utm[0], entry_utm_medium=utm[1], entry_utm_campaign="autumn_sale" if utm[0] else "",
                             entry_referrer={"Organic Search": "https://www.google.com/", "Referral": "https://blog.runners.example/", "Paid Social": "https://m.facebook.com/"}.get(ch, ""),
                             referrer_domain={"Organic Search": "google.com", "Referral": "blog.runners.example", "Paid Social": "facebook.com"}.get(ch, "(direct)"),
                             click_id_type={"Paid Search": "gclid", "Paid Social": "fbclid"}.get(ch, ""))
                    sim.add(r)
                    if contaminated and vi == 0:
                        alt = VARS[(VARS.index(var) + 1) % 3]
                        r2 = base_row(v, vt + timedelta(minutes=3), "experiment_view", r["url"], [[1717, alt, s]], sid)
                        r2.update(experiment_id=1717, variation_id=alt)
                        sim.add(r2)
                    t = vt
                    for _p in range(1 + int(rng.expovariate(1 / 2.2))):
                        t += timedelta(seconds=rng.randint(15, 140))
                        sim.add(base_row(v, t, "page_view", rng.choice(["https://shop.example/", "https://shop.example/product/trail-runner", "https://shop.example/c/apparel", "https://shop.example/cart"]), exp, sid))
                    if rng.random() < .05:
                        t += timedelta(seconds=30)
                        rr = base_row(v, t, "size_guide_opened", "https://shop.example/product/trail-runner", exp, sid); rr["props"] = {"source": "pdp"}; sim.add(rr)
                    if rng.random() < .03 * (1.05 if var == 101 else 1):
                        t += timedelta(seconds=40)
                        rr = base_row(v, t, "generate_lead", "https://shop.example/newsletter", exp, sid); rr["props"] = {"lead_type": "newsletter"}; sim.add(rr)
                    if rng.random() < .12:
                        t += timedelta(seconds=20)
                        rr = base_row(v, t, "conversion", "https://shop.example/quiz", exp, sid); rr["goal_id"] = 12; sim.add(rr)
                    # funnel
                    if rng.random() >= min(.9, .22 * b * {100: 1.0, 101: 1.18, 102: 0.95}[var]):
                        continue
                    nlines = 1 + (rng.random() < .3)
                    lines = []
                    for _ in range(nlines):
                        pid, pname, price, variants = PRODUCTS[min(int(rng.expovariate(1 / 2.2)), len(PRODUCTS) - 1)]
                        vname = pick(rng, variants)[0]
                        lines.append({"item_id": f"{pid}-{vname.replace(' ', '').replace('/', '-')}", "product_id": pid, "item_name": pname,
                                      "item_variant": vname, "price": None if rng.random() < .07 else price, "quantity": 1 + (rng.random() < .15)})
                    cur = "EUR" if rng.random() < .8 else ("USD" if rng.random() < .7 else "GBP")
                    val = sum((l["price"] or 0) * l["quantity"] for l in lines)
                    t += timedelta(seconds=50)
                    sim.add(base_row(v, t, "add_to_cart", "https://shop.example/cart", exp, sid) | {"value_native": val, "currency": cur}, lines)
                    if rng.random() > .55: continue
                    t += timedelta(seconds=60); sim.add(base_row(v, t, "begin_checkout", "https://shop.example/checkout", exp, sid) | {"value_native": val, "currency": cur})
                    if rng.random() > .80: continue
                    t += timedelta(seconds=60); sim.add(base_row(v, t, "add_shipping_info", "https://shop.example/checkout/contact", exp, sid))
                    if rng.random() > .82: continue
                    pt = pick(rng, [("card", .57), ("paypal", .27), ("apple_pay", .12), ("klarna", .04)], 1)[0]
                    coupon = rng.choice(["WELCOME10", "WELCOME10", "FREESHIP", "AUTUMN15"]) if rng.random() < .2 else ""
                    t += timedelta(seconds=45)
                    rr = base_row(v, t, "add_payment_info", "https://shop.example/checkout/payment", exp, sid); rr["props"] = {"payment_type": pt} | ({"coupon": coupon} if coupon else {}); sim.add(rr)
                    pay_ok = .80 if not (var == 101 and pt == "apple_pay") else .60
                    if rng.random() > pay_ok * LIFT[var] / 1.05: continue
                    bought_orders += 1
                    oid = f"ORD-{vid_n:05d}-{vi}"
                    paid = round(sum((l["price"] or 0) * l["quantity"] for l in lines) * (0.9 if coupon == "WELCOME10" else 1), 2)
                    t += timedelta(seconds=30)
                    pr = base_row(v, t, "purchase", "https://shop.example/thank-you", exp, sid)
                    pr.update(order_id=oid, value_native=paid, currency=cur, purchase_type="initial")
                    pr["props"] = {"payment_type": pt, "tax": f"{paid * .21:.2f}", "shipping": "4.90"} | ({"coupon": coupon} if coupon else {})
                    sim.add(pr, [dict(l) for l in lines])
                    if rng.random() < .04:   # thank-you reload duplicate
                        dup = dict(pr); dup["event_id"] = uuid_for(oid, "reload"); dup["client_ts"] = ts(t + timedelta(seconds=9)); sim.add(dup, [dict(l) for l in lines])
                    if rng.random() < (.21 if var == 101 else .16):
                        t += timedelta(seconds=25)
                        up = base_row(v, t, "purchase", "https://shop.example/thank-you", exp, sid)
                        up.update(order_id=oid + "-U1", parent_order_id=oid, purchase_type="upsell", value_native=UPSELL[2], currency=cur)
                        sim.add(up, [{"item_id": UPSELL[0], "product_id": UPSELL[0], "item_name": UPSELL[1], "item_variant": "Default", "price": UPSELL[2], "quantity": 1}])
    return sim


# ─────────────────────────── oracle: modelling ───────────────────────────

def parse_ts(s):
    return datetime.strptime(s, "%Y-%m-%d %H:%M:%S.%f").replace(tzinfo=UTC)


def model(sim, exp_id, frm, to, variations, weights, ccy="EUR"):
    end = datetime.strptime(to, "%Y-%m-%d").replace(tzinfo=UTC) + timedelta(days=1)
    fromd = datetime.strptime(frm, "%Y-%m-%d").replace(tzinfo=UTC)
    # exposures (merged view)
    expo = {}
    for e in sorted(sim.events, key=lambda r: r["client_ts"]):
        if e["event_name"] != "experiment_view" or e["is_bot"] or e["experiment_id"] != exp_id:
            continue
        x = expo.setdefault(e["visitor_id"], {"visitor_id": e["visitor_id"], "first_exposed_at": e["client_ts"], "variation_id": e["variation_id"],
                                              "variations_seen": set(), "sessions": 0, **{k: e[k] for k in ("channel", "referrer_domain", "country", "region", "city", "device_type", "os_name", "browser_name", "visit_number")},
                                              "utm_source": e["entry_utm_source"], "utm_medium": e["entry_utm_medium"], "utm_campaign": e["entry_utm_campaign"],
                                              "screen_resolution": f'{e["screen_w"]}x{e["screen_h"]}'})
        x["variations_seen"].add(e["variation_id"]); x["sessions"] += 1
    exposures_view = []
    for x in expo.values():
        exposures_view.append({**x, "variations_seen": sorted(x["variations_seen"])})
    multi = sum(1 for x in expo.values() if len(x["variations_seen"]) > 1)
    exposed = {k: x for k, x in expo.items() if len(x["variations_seen"]) == 1 and fromd <= parse_ts(x["first_exposed_at"]) < end}
    for x in exposed.values():
        x["date"] = x["first_exposed_at"][:10]
    # dedup purchases globally
    seen, evs = set(), []
    for e in sorted(sim.events, key=lambda r: r["client_ts"]):
        if e["event_name"] == "purchase":
            if e["order_id"] in seen: continue
            seen.add(e["order_id"])
        evs.append(e)
    kept_ids = {e["event_id"] for e in evs}
    mismatch = 0
    att = defaultdict(list)
    for e in evs:
        if e["is_bot"] or exp_id not in e["exp_ids"] or e["visitor_id"] not in exposed: continue
        if parse_ts(e["client_ts"]) >= end: continue
        x = exposed[e["visitor_id"]]
        if parse_ts(e["client_ts"]) < parse_ts(x["first_exposed_at"]): continue
        if e["exp_var_ids"][e["exp_ids"].index(exp_id)] != x["variation_id"] and e["event_name"] != "experiment_view": mismatch += 1
        att[e["visitor_id"]].append(e)
    # new vs returning (PRD §1.3a): returning = the visitor started a 2nd experiment session (session_idx >= 2),
    # i.e. >= 2 distinct session starts for this experiment across their attributed events. Per visitor, not per event.
    for vid, x in exposed.items():
        starts = {e["exp_session_starts"][e["exp_ids"].index(exp_id)] for e in att.get(vid, [])}
        x["visitor_type"] = "returning" if len(starts) >= 2 else "new"
    vt = {vid: x["visitor_type"] for vid, x in exposed.items()}
    for row in exposures_view:
        row["visitor_type"] = vt.get(row["visitor_id"], "new")
    items_by_event = defaultdict(list)
    for it in sim.items:
        items_by_event[it["event_id"]].append(it)
    # cap threshold (p99 of initial order values, report ccy)
    ov = [e["value_native"] * FX[e["currency"]] for es in att.values() for e in es if e["event_name"] == "purchase" and e["purchase_type"] == "initial"]
    cap = float(np.percentile(ov, 99)) if ov else 0.0
    return dict(exposed=exposed, att=att, items=items_by_event, multi=multi, mismatch=mismatch, cap=cap, exposures_view=exposures_view,
                exp_id=exp_id, frm=frm, to=to, variations=variations, weights=weights, ccy=ccy, kept=kept_ids)


def visitor_values(M, vid, funnel="closed", capped=False):
    es = M["att"].get(vid, [])
    names = defaultdict(list)
    for e in es: names[e["event_name"]].append(e)
    cap = M["cap"]
    def money(e):
        v = e["value_native"] * FX[e["currency"]]
        return min(v, cap) if capped and e["purchase_type"] == "initial" else v
    init = [e for e in names["purchase"] if e["purchase_type"] in ("initial", "")]
    ups = [e for e in names["purchase"] if e["purchase_type"] == "upsell"]
    fired = {s: bool(names[s]) if s != "purchase" else bool(init) for s in STEPS}
    reached, ok = {}, True
    for s in STEPS:
        ok = ok and fired[s]
        reached[s] = ok if funnel == "closed" else fired[s]
    init_items = [it for e in init for it in M["items"][e["event_id"]]]
    carted = defaultdict(int); bought = defaultdict(int)
    for e in names["add_to_cart"]:
        for it in M["items"][e["event_id"]]: carted[it["product_id"]] += it["quantity"]
    for e in names["purchase"]:
        for it in M["items"][e["event_id"]]: bought[it["product_id"]] += it["quantity"]
    sess = defaultdict(lambda: [None, None])
    for e in es:
        i = e["exp_ids"].index(M["exp_id"]); s0 = e["exp_session_starts"][i]; t = parse_ts(e["client_ts"]).timestamp()
        sess[s0][1] = max(sess[s0][1] or t, t)
    durs = [max(0.0, last - s0) for s0, (_, last) in sess.items()]
    upsold_orders = {e["parent_order_id"] for e in ups}
    lead = bool(names["generate_lead"] or names["sign_up"])
    return {
        "purchased": 1 if init else 0, "orders": len(init), "init_rev": sum(money(e) for e in init), "rev": sum(money(e) for e in init) + sum(money(e) for e in ups),
        "ups_rev": sum(money(e) for e in ups), "order_vals": [money(e) for e in init], "upsell_orders": sum(1 for e in init if e["order_id"] in upsold_orders),
        "atc": 1 if names["add_to_cart"] else 0, "bc": 1 if names["begin_checkout"] else 0, "asi": 1 if names["add_shipping_info"] else 0,
        "api": 1 if names["add_payment_info"] else 0, "lead": 1 if lead else 0, "reached": reached,
        "pages": len(names["page_view"]), "sess_secs": durs, "sessions": len(sess),
        "units_init": sum(it["quantity"] for it in init_items), "unit_prices": [(it["price"] or 0) * FX[e["currency"]] for e in init for it in M["items"][e["event_id"]] for _ in range(it["quantity"])],
        "units_all": sum(it["quantity"] for e in names["purchase"] for it in M["items"][e["event_id"]]),
        "b2c_num": sum(min(bought[p], carted[p]) for p in carted), "b2c_den": sum(carted.values()),
        "coupon_orders": sum(1 for e in init if e["props"].get("coupon")),
        "event:size_guide_opened": 1 if names["size_guide_opened"] else 0,
        "goal:12": 1 if any(e["goal_id"] == 12 for e in names["conversion"]) else 0,
        "payment_type": (names["add_payment_info"][-1]["props"].get("payment_type") if names["add_payment_info"] else None),
    }


def ratio(a, b):
    return None if not b else a / b


def metric_value(key, V):
    n = len(V); S = lambda f: sum(f(v) for v in V)
    if n == 0: return None
    purch = S(lambda v: v["purchased"]); orders = S(lambda v: v["orders"])
    reached = lambda s: S(lambda v: 1 if v["reached"][s] else 0)
    m = {
        "visitors": n, "purchasers": purch, "orders": orders, "revenue": round(S(lambda v: v["rev"]), 2),
        "cr": purch / n, "aov": ratio(S(lambda v: v["init_rev"]), orders), "rpv": S(lambda v: v["rev"]) / n, "arpu": S(lambda v: v["rev"]) / n,
        "add_to_cart_rate": S(lambda v: v["atc"]) / n, "begin_checkout_rate": S(lambda v: v["bc"]) / n,
        "contact_details_rate": S(lambda v: v["asi"]) / n, "payment_load_rate": S(lambda v: v["api"]) / n,
        "lead_register_rate": S(lambda v: v["lead"]) / n, "upsell_rate": ratio(S(lambda v: v["upsell_orders"]), orders),
        "pages_per_visitor": S(lambda v: v["pages"]) / n, "session_duration": ratio(S(lambda v: sum(v["sess_secs"])), S(lambda v: v["sessions"])),
        "step_cart_to_checkout": ratio(reached("begin_checkout"), reached("add_to_cart")),
        "step_checkout_to_contact": ratio(reached("add_shipping_info"), reached("begin_checkout")),
        "step_contact_to_payment": ratio(reached("add_payment_info"), reached("add_shipping_info")),
        "step_payment_to_purchase": ratio(reached("purchase"), reached("add_payment_info")),
        "cart_abandonment": ratio(S(lambda v: 1 if v["atc"] and not v["purchased"] else 0), S(lambda v: v["atc"])),
        "checkout_abandonment": ratio(S(lambda v: 1 if v["bc"] and not v["purchased"] else 0), S(lambda v: v["bc"])),
        "basket_size": ratio(S(lambda v: v["units_init"]), orders), "avg_item_price": ratio(S(lambda v: sum(v["unit_prices"])), S(lambda v: len(v["unit_prices"]))),
        "units_sold": S(lambda v: v["units_all"]), "buy_to_cart": ratio(S(lambda v: v["b2c_num"]), S(lambda v: v["b2c_den"])),
        "coupon_rate": ratio(S(lambda v: v["coupon_orders"]), orders), "orders_per_purchaser": ratio(orders, purch),
        "upsell_rpv": S(lambda v: v["ups_rev"]) / n,
        "lead_to_customer": ratio(S(lambda v: 1 if v["lead"] and v["purchased"] else 0), S(lambda v: v["lead"])),
        "repeat_purchase_rate": ratio(S(lambda v: 1 if v["orders"] >= 2 else 0), purch),
        "event:size_guide_opened": S(lambda v: v["event:size_guide_opened"]) / n, "goal:12": S(lambda v: v["goal:12"]) / n,
    }
    if key.startswith("reached:"): return reached(key.split(":", 1)[1])
    return m[key]


LOWER = {"cart_abandonment", "checkout_abandonment"}
BETA = {  # key -> (successes, trials)
    "cr": (lambda V: sum(v["purchased"] for v in V), len),
    "add_to_cart_rate": (lambda V: sum(v["atc"] for v in V), len), "begin_checkout_rate": (lambda V: sum(v["bc"] for v in V), len),
    "contact_details_rate": (lambda V: sum(v["asi"] for v in V), len), "payment_load_rate": (lambda V: sum(v["api"] for v in V), len),
    "lead_register_rate": (lambda V: sum(v["lead"] for v in V), len),
    "event:size_guide_opened": (lambda V: sum(v["event:size_guide_opened"] for v in V), len), "goal:12": (lambda V: sum(v["goal:12"] for v in V), len),
    "upsell_rate": (lambda V: sum(v["upsell_orders"] for v in V), lambda V: sum(v["orders"] for v in V)),
    "coupon_rate": (lambda V: sum(v["coupon_orders"] for v in V), lambda V: sum(v["orders"] for v in V)),
    "cart_abandonment": (lambda V: sum(1 for v in V if v["atc"] and not v["purchased"]), lambda V: sum(v["atc"] for v in V)),
    "checkout_abandonment": (lambda V: sum(1 for v in V if v["bc"] and not v["purchased"]), lambda V: sum(v["bc"] for v in V)),
    "step_cart_to_checkout": (lambda V: sum(v["reached"]["begin_checkout"] for v in V), lambda V: sum(v["reached"]["add_to_cart"] for v in V)),
    "step_checkout_to_contact": (lambda V: sum(v["reached"]["add_shipping_info"] for v in V), lambda V: sum(v["reached"]["begin_checkout"] for v in V)),
    "step_contact_to_payment": (lambda V: sum(v["reached"]["add_payment_info"] for v in V), lambda V: sum(v["reached"]["add_shipping_info"] for v in V)),
    "step_payment_to_purchase": (lambda V: sum(v["reached"]["purchase"] for v in V), lambda V: sum(v["reached"]["add_payment_info"] for v in V)),
    "buy_to_cart": (lambda V: sum(v["b2c_num"] for v in V), lambda V: sum(v["b2c_den"] for v in V)),
    "lead_to_customer": (lambda V: sum(1 for v in V if v["lead"] and v["purchased"]), lambda V: sum(v["lead"] for v in V)),
    "repeat_purchase_rate": (lambda V: sum(1 for v in V if v["orders"] >= 2), lambda V: sum(v["purchased"] for v in V)),
}
NORMAL_OBS = {  # key -> observations (list) per group
    "pages_per_visitor": lambda V: [v["pages"] for v in V],
    "session_duration": lambda V: [sum(v["sess_secs"]) / v["sessions"] for v in V if v["sessions"]],
    "basket_size": lambda V: [None] and [q for v in V for q in ([v["units_init"] / v["orders"]] * v["orders"] if v["orders"] else [])],
    "avg_item_price": lambda V: [p for v in V for p in v["unit_prices"]],
    "orders_per_purchaser": lambda V: [v["orders"] for v in V if v["purchased"]],
}


def draws_for(key, V, cap, N, rng):
    if key in BETA:
        x, n = BETA[key][0](V), BETA[key][1](V)
        return rng.beta(1 + x, 1 + n - x, N), n, x
    if key == "aov":
        vals = [min(o, cap) for v in V for o in v["order_vals"] if o > 0]
        return lognorm_draws(vals, N, rng), len(vals), len(vals)
    if key in ("rpv", "arpu", "upsell_rpv"):
        f = (lambda v: v["ups_rev"]) if key == "upsell_rpv" else (lambda v: min(v["rev"], cap * max(1, v["orders"])))
        pay = [f(v) for v in V if f(v) > 0]
        p = rng.beta(1 + len(pay), 1 + len(V) - len(pay), N)
        return p * lognorm_draws(pay, N, rng), len(V), len(pay)
    if key in NORMAL_OBS:
        obs = np.array(NORMAL_OBS[key](V), dtype=float)
        if len(obs) < 2: return None, len(obs), len(obs)
        return rng.normal(obs.mean(), obs.std(ddof=1) / math.sqrt(len(obs)) + 1e-12, N), len(obs), len(obs)
    return None, 0, 0


def lognorm_draws(vals, N, rng):
    if len(vals) < 2:
        return np.full(N, np.nan)
    lv = np.log(np.array(vals))
    n, m, s2 = len(lv), lv.mean(), lv.var(ddof=1)
    sig2 = (n - 1) * s2 / rng.chisquare(n - 1, N)
    mu = rng.normal(m, np.sqrt(sig2 / n))
    return np.exp(np.minimum(mu + sig2 / 2, 50.0))


MIN = {"visitors": 100, "conv": 10}


def stats_block(key, groups, control, cap, N, seed_key, conf=0.95):
    rng = np.random.default_rng(int(hashlib.sha1(seed_key.encode()).hexdigest()[:8], 16))
    D, info = {}, {}
    for var, V in groups.items():
        d, n, x = draws_for(key, V, cap, N, rng)
        D[var] = d; info[var] = (len(V), n, x)
    if any(d is None for d in D.values()): return None
    lower = key in LOWER
    stack = np.vstack([D[v] for v in groups])
    best_idx = (np.nanargmin if lower else np.nanargmax)(stack, axis=0)
    out = {}
    for i, var in enumerate(groups):
        ins = info[var][0] < MIN["visitors"] or info[var][2] < MIN["conv"]
        o = {"chance_to_be_best": round(float((best_idx == i).mean()), 4)}
        if var != control:
            c, v = D[control], D[var]
            beat = (v < c) if lower else (v > c)
            lift = v / c - 1
            loss = (np.maximum(v - c, 0) if lower else np.maximum(c - v, 0)) / np.nanmean(c)
            a = (1 - conf) / 2
            o.update(chance_to_beat_control=round(float(np.nanmean(beat)), 4), lift=round(float(np.nanmean(lift)), 4),
                     lift_ci=[round(float(np.nanpercentile(lift, 100 * a)), 4), round(float(np.nanpercentile(lift, 100 * (1 - a))), 4)],
                     expected_loss=round(float(np.nanmean(loss)), 5))
        if ins: o["insufficient_data"] = True
        out[str(var)] = o
    return out


def r6(x):
    return None if x is None else (round(x, 6) if isinstance(x, float) else x)


def report(M, group_by, metrics, funnel="closed", capped=False, with_stats=True, planning=None, filters=None):
    VV = {vid: visitor_values(M, vid, funnel, capped) for vid in M["exposed"]}
    def key_of(vid, keys):
        x = M["exposed"][vid]; out = {}
        for k in keys:
            if k == "variation": out[k] = x["variation_id"]
            elif k == "date": out[k] = x["date"]
            elif k == "payment_type": out[k] = VV[vid]["payment_type"] or "(none)"
            else: out[k] = x[k] or "(none)"
        return out
    ids = [vid for vid in M["exposed"] if not filters or all(M["exposed"][vid][k] in vals for k, vals in filters.items())]
    if "payment_type" in group_by:
        ids = [vid for vid in ids if VV[vid]["payment_type"]]
    dims = [k for k in group_by if k not in ("date", "variation")]
    # top 10 + other
    for d in dims:
        cnt = defaultdict(int)
        for vid in ids: cnt[key_of(vid, [d])[d]] += 1
        top = {k for k, _ in sorted(cnt.items(), key=lambda kv: -kv[1])[:10]}
        for vid in ids:
            pass
        M.setdefault("_top", {})[d] = top
    def gk(vid, keys):
        k = key_of(vid, keys)
        for d in dims:
            if d in k and k[d] not in M["_top"][d]: k[d] = "(other)"
        return tuple(k[x] for x in keys)
    def build(keys, draws):
        G = defaultdict(list)
        for vid in ids: G[gk(vid, keys)].append(VV[vid])
        rows = []
        for k, V in G.items():
            row = dict(zip(keys, k))
            for m in metrics: row[m] = r6(metric_value(m, V))
            rows.append(row)
        if with_stats and "variation" in keys:
            other = [x for x in keys if x != "variation"]
            seg = defaultdict(dict)
            for k, V in G.items():
                kk = dict(zip(keys, k)); seg[tuple(kk[x] for x in other)][kk["variation"]] = V
            for sk, groups in seg.items():
                groups = {v: groups[v] for v in M["variations"] if v in groups}
                if M["variations"][0] not in groups: continue
                st = {m: stats_block(m, groups, M["variations"][0], M["cap"], draws, f'{M["exp_id"]}|{m}|{sk}') for m in metrics if m in BETA or m in NORMAL_OBS or m in ("aov", "rpv", "arpu", "upsell_rpv")}
                for row in rows:
                    if tuple(row[x] for x in other) == sk:
                        row["stats"] = {m: (s[str(row["variation"])] if s else None) for m, s in st.items()}
        if "payment_type" in keys:
            for row in rows: row["post_exposure"] = True
        order = {v: i for i, v in enumerate(M["variations"])}
        kd = [d for d in dims if d in keys]
        size = {d: defaultdict(int) for d in kd}
        for vid in ids:
            for d in kd: size[d][gk(vid, [d])[0]] += 1
        rows.sort(key=lambda r: (r.get("date", ""), *[-size[d][r[d]] for d in kd], *[str(r[d]) for d in kd], order.get(r.get("variation"), 99)))
        return rows
    totals = build(["variation"], 100_000)
    rows = build(group_by, 100_000 if not dims else 10_000)
    resp = {"experiment_id": M["exp_id"], "from": M["frm"], "to": M["to"], "report_currency": M["ccy"], "computed_at": f'{M["to"]}T10:45:03Z',
            "funnel": funnel, "quality": {"multi_variation_visitors": M["multi"], "variation_mismatch_events": M["mismatch"]},
            "capping": {"threshold": round(M["cap"], 2), "capped_orders": {str(v): sum(1 for vid in ids if M["exposed"][vid]["variation_id"] == v for o in VV[vid]["order_vals"] if o > M["cap"]) for v in M["variations"]}},
            "srm": srm(M, ids), "columns": group_by + metrics, "rows": rows, "totals": totals}
    if "date" in group_by: resp["totals_by_date"] = build(["date", "variation"], 10_000)
    if planning: resp["planning"] = plan(M, ids, VV, **planning)
    return resp


def srm(M, ids):
    obs = [sum(1 for vid in ids if M["exposed"][vid]["variation_id"] == v) for v in M["variations"]]
    tot = sum(obs); w = M["weights"]
    chi2 = sum((o - tot * wi) ** 2 / (tot * wi) for o, wi in zip(obs, w)) if tot else 0.0
    df = len(obs) - 1
    p = math.exp(-chi2 / 2) if df == 2 else math.erfc(math.sqrt(chi2 / 2)) if df == 1 else None
    return {"expected_weights": {str(v): round(wi, 4) for v, wi in zip(M["variations"], w)}, "chi2": round(chi2, 4), "p_value": round(p, 4), "ok": p >= 0.001}


def plan(M, ids, VV, primary_metric="cr", mde=0.15, power=0.8, confidence=0.95):
    from statistics import NormalDist
    ctrl = [VV[vid] for vid in ids if M["exposed"][vid]["variation_id"] == M["variations"][0]]
    p1 = metric_value(primary_metric, ctrl); p2 = p1 * (1 + mde); z = NormalDist().inv_cdf(1 - (1 - confidence) / 2) + NormalDist().inv_cdf(power)
    need = math.ceil(z * z * (p1 * (1 - p1) + p2 * (1 - p2)) / (p2 - p1) ** 2)
    per = {str(v): sum(1 for vid in ids if M["exposed"][vid]["variation_id"] == v) for v in M["variations"]}
    end = datetime.strptime(M["to"], "%Y-%m-%d").date()
    last7 = sum(1 for vid in ids if (end - datetime.strptime(M["exposed"][vid]["date"], "%Y-%m-%d").date()).days < 7) / 7 / len(M["variations"])
    progress = min(per.values()) / need
    return {"primary_metric": primary_metric, "baseline": round(p1, 6), "mde": mde, "planned_visitors_per_variation": need,
            "visitors_per_variation": per, "progress": round(progress, 4), "avg_daily_visitors_7d": round(last7, 1),
            "days_remaining": max(0, math.ceil((need - min(per.values())) / last7)) if last7 else None}


def products(M, limit=8, purchase_type="all"):
    VV_var = {vid: M["exposed"][vid]["variation_id"] for vid in M["exposed"]}
    P = defaultdict(lambda: {"name": "", "unit_price": 0, "by": defaultdict(lambda: {"added": 0, "units": 0, "rev": 0.0, "b2c_num": 0, "variants": defaultdict(lambda: {"units": 0, "rev": 0.0})})})
    tot_units = defaultdict(int); tot_rev = defaultdict(float)
    for vid, es in M["att"].items():
        var = VV_var[vid]; carted = defaultdict(int); bought = defaultdict(int)
        for e in es:
            if e["event_name"] == "add_to_cart":
                for it in M["items"][e["event_id"]]:
                    P[it["product_id"]]["by"][var]["added"] += it["quantity"]; carted[it["product_id"]] += it["quantity"]
            if e["event_name"] == "purchase" and (purchase_type == "all" or e["purchase_type"] == purchase_type):
                for it in M["items"][e["event_id"]]:
                    p = P[it["product_id"]]; p["name"] = it["item_name"]; p["unit_price"] = it["price"] or p["unit_price"]
                    rev = (it["price"] or 0) * it["quantity"] * FX[e["currency"]]
                    b = p["by"][var]; b["units"] += it["quantity"]; b["rev"] += rev
                    vv = b["variants"][it["item_variant"] or it["item_id"]]; vv["units"] += it["quantity"]; vv["rev"] += rev
                    tot_units[var] += it["quantity"]; tot_rev[var] += rev; bought[it["product_id"]] += it["quantity"]
        for pid in carted: P[pid]["by"][var]["b2c_num"] += min(bought[pid], carted[pid])
    ctrl = M["variations"][0]
    order = sorted(P, key=lambda k: -P[k]["by"][ctrl]["rev"])
    out = []
    def entry(pid, p):
        byv = {}
        for v in M["variations"]:
            b = p["by"][v]
            varis = sorted(b["variants"].items(), key=lambda kv: -kv[1]["units"])
            byv[str(v)] = {"units_added": b["added"], "units_purchased": b["units"], "units_share": r6(ratio(b["units"], tot_units[v])),
                           "buy_to_cart": r6(ratio(b["b2c_num"], b["added"])), "revenue": round(b["rev"], 2), "revenue_share": r6(ratio(b["rev"], tot_rev[v]))}
        names = []
        for v in M["variations"]:
            for vn in p["by"][v]["variants"]:
                if vn not in names: names.append(vn)
        variants = []
        for vn in names:
            sv = {}
            for v in M["variations"]:
                b = p["by"][v]; vv = b["variants"].get(vn, {"units": 0, "rev": 0.0})
                sv[str(v)] = {"units": vv["units"], "share_of_product": r6(ratio(vv["units"], b["units"])), "revenue_share": r6(ratio(vv["rev"], tot_rev[v]))}
            variants.append({"item_variant": vn, "by_variation": sv, "low_sample": p["by"][ctrl]["variants"].get(vn, {"units": 0})["units"] < 15})
        return {"product_id": pid, "name": p["name"], "unit_price": p["unit_price"], "by_variation": byv, "variants": variants}
    for pid in order[:limit]: out.append(entry(pid, P[pid]))
    rest = order[limit:]
    if rest:
        agg = {"name": "Other products", "unit_price": None, "by": defaultdict(lambda: {"added": 0, "units": 0, "rev": 0.0, "b2c_num": 0, "variants": {}})}
        for pid in rest:
            for v, b in P[pid]["by"].items():
                a = agg["by"][v]; a["added"] += b["added"]; a["units"] += b["units"]; a["rev"] += b["rev"]; a["b2c_num"] += b["b2c_num"]
        e = entry("(other)", agg); e["variants"] = []; e["product_count"] = len(rest); out.append(e)
    return {"experiment_id": M["exp_id"], "from": M["frm"], "to": M["to"], "report_currency": M["ccy"], "purchase_type": purchase_type,
            "sort": "control_revenue", "limit": limit, "offset": 0, "total_products": len(order), "products": out}


def distributions(M, bins=None):
    var_of = {vid: M["exposed"][vid]["variation_id"] for vid in M["exposed"]}
    D = {k: {str(v): defaultdict(int) for v in M["variations"]} for k in ("payment_type", "coupon", "currency")}
    vals = {str(v): [] for v in M["variations"]}
    for vid, es in M["att"].items():
        v = str(var_of[vid])
        for e in es:
            if e["event_name"] == "add_payment_info": D["payment_type"][v][e["props"].get("payment_type", "(none)")] += 1
            if e["event_name"] == "purchase" and e["purchase_type"] == "initial":
                D["coupon"][v][e["props"].get("coupon") or "No coupon"] += 1
                D["currency"][v][e["currency"]] += 1
                vals[v].append(e["value_native"] * FX[e["currency"]])
    def fmt(d):
        out = {}
        for v, c in d.items():
            tot = sum(c.values())
            out[v] = [{"value": k, "count": n, "share": r6(n / tot)} for k, n in sorted(c.items(), key=lambda kv: -kv[1])]
        return out
    allv = sorted(x for l in vals.values() for x in l)
    if bins is None:
        bins = [0] + [round(float(np.percentile(allv, q)), 2) for q in (12.5, 25, 37.5, 50, 62.5, 75, 87.5)] if allv else [0]
    hist = {}
    for v, l in vals.items():
        cnt = [0] * len(bins)
        for x in l:
            i = max(i for i, b in enumerate(bins) if x >= b); cnt[i] += 1
        hist[v] = [{"from": b, "to": bins[i + 1] if i + 1 < len(bins) else None, "count": c, "share": r6(c / len(l)) if l else None} for i, (b, c) in enumerate(zip(bins, cnt))]
    return {"experiment_id": M["exp_id"], "from": M["frm"], "to": M["to"], "report_currency": M["ccy"],
            "distributions": {"payment_type": {"basis": "add_payment_info events", "by_variation": fmt(D["payment_type"])},
                              "coupon": {"basis": "initial orders", "by_variation": fmt(D["coupon"])},
                              "currency": {"basis": "initial orders", "by_variation": fmt(D["currency"])},
                              "order_value": {"basis": "initial orders", "bins": bins, "by_variation": hist}}}


EVENT_PARAM_SPEC = {
    "purchase": ["order_id", "value_native", "currency", "items", "items[].item_id", "items[].price", "items[].quantity", "purchase_type"],
    "add_to_cart": ["items", "items[].item_id", "items[].price"],
    "add_payment_info": ["payment_type"], "begin_checkout": [], "add_shipping_info": [], "experiment_view": [], "page_view": [],
}


def health(M):
    var_of = {vid: M["exposed"][vid]["variation_id"] for vid in M["exposed"]}
    out = []
    for name, req in EVENT_PARAM_SPEC.items():
        es = [e for vid, l in M["att"].items() for e in l if e["event_name"] == name]
        # health counts raw attributed events (duplicates included)
        raw = [e for e in [] ]
        ev_by = {str(v): 0 for v in M["variations"]}; vis_by = {str(v): set() for v in M["variations"]}
        for e in es: ev_by[str(var_of[e["visitor_id"]])] += 1; vis_by[str(var_of[e["visitor_id"]])].add(e["visitor_id"])
        params = []
        for p in req:
            if p.startswith("items[]."):
                f = p.split(".", 1)[1]; its = [it for e in es for it in M["items"][e["event_id"]]]
                pct = ratio(sum(1 for it in its if it.get(f) is not None), len(its))
            elif p == "items": pct = ratio(sum(1 for e in es if M["items"][e["event_id"]]), len(es))
            elif p == "payment_type": pct = ratio(sum(1 for e in es if e["props"].get("payment_type")), len(es))
            else: pct = ratio(sum(1 for e in es if e.get(p) not in (None, "", 0)), len(es))
            params.append({"param": p, "required": True, "present_pct": r6(pct)})
        status = "missing" if not es else ("warning" if any((x["present_pct"] or 0) < .95 for x in params) else "ok")
        last = max((e["client_ts"] for e in es), default=None)
        out.append({"event_name": name, "status": status, "last_event_at": last, "events": ev_by, "visitors": {k: len(s) for k, s in vis_by.items()}, "params": params})
    st = {e["event_name"]: e["status"] for e in out}
    needs = {"cr": ["purchase"], "aov": ["purchase"], "rpv": ["purchase"], "add_to_cart_rate": ["add_to_cart"], "buy_to_cart": ["add_to_cart", "purchase"],
             "payment_load_rate": ["add_payment_info"], "step_payment_to_purchase": ["add_payment_info", "purchase"], "avg_item_price": ["purchase"]}
    metrics = [{"key": k, "availability": "unavailable" if any(st[n] == "missing" for n in ev) else ("limited" if any(st[n] == "warning" for n in ev) else "full"),
                "reason": ", ".join(f"{n}: {st[n]}" for n in ev if st[n] != "ok")} for k, ev in needs.items()]
    ids = list(M["exposed"])
    return {"experiment_id": M["exp_id"], "from": M["frm"], "to": M["to"], "events": out, "metrics": metrics, "srm": srm(M, ids),
            "summary": {"events_receiving": sum(1 for e in out if e["status"] != "missing"), "events_expected": len(out),
                        "param_warnings": sum(1 for e in out if e["status"] == "warning"),
                        "metrics_full": sum(1 for m in metrics if m["availability"] == "full"), "metrics_limited": sum(1 for m in metrics if m["availability"] == "limited")}}


# ─────────────────────────── write ───────────────────────────

ALL = ["visitors", "purchasers", "orders", "revenue", "cr", "aov", "rpv", "arpu", "add_to_cart_rate", "begin_checkout_rate", "contact_details_rate",
       "payment_load_rate", "lead_register_rate", "upsell_rate", "pages_per_visitor", "session_duration",
       "reached:add_to_cart", "reached:begin_checkout", "reached:add_shipping_info", "reached:add_payment_info", "reached:purchase",
       "step_cart_to_checkout", "step_checkout_to_contact", "step_contact_to_payment", "step_payment_to_purchase",
       "cart_abandonment", "checkout_abandonment", "basket_size", "avg_item_price", "units_sold", "buy_to_cart", "coupon_rate",
       "orders_per_purchaser", "upsell_rpv", "lead_to_customer", "repeat_purchase_rate", "event:size_guide_opened", "goal:12"]


def dump(path, obj, pretty=True):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(obj, f, indent=2 if pretty else None, ensure_ascii=False, default=lambda o: sorted(o) if isinstance(o, set) else str(o))


def jsonl(path, rows):
    import gzip
    os.makedirs(os.path.dirname(path), exist_ok=True)
    op = gzip.open if path.endswith(".gz") else open
    with op(path, "wt") as f:
        for r in rows: f.write(json.dumps(r, ensure_ascii=False, default=lambda o: sorted(o)) + "\n")


def write_set(name, sim, M, sample_n=None):
    base = os.path.join(HERE, name)
    ev_sorted = sorted(sim.events, key=lambda r: r["client_ts"])
    ext = ".jsonl.gz" if sample_n else ".jsonl"
    jsonl(f"{base}/raw/events{ext}", ev_sorted)
    jsonl(f"{base}/raw/event_items{ext}", sim.items)
    expo = sorted(M["exposures_view"], key=lambda x: x["first_exposed_at"])
    if sample_n:
        jsonl(f"{base}/raw/exposures.view.jsonl.gz", expo)
        # pretty sample: a few complete, representative visitor journeys
        by = defaultdict(list)
        for r in ev_sorted: by[r["visitor_id"]].append(r)
        def has(v, f): return any(f(r) for r in by[v])
        wanted = [
            lambda v: has(v, lambda r: r["purchase_type"] == "upsell"),                         # buyer + upsell
            lambda v: sum(1 for r in by[v] if r["event_name"] == "experiment_view") > 1 and has(v, lambda r: r["event_name"] == "purchase"),  # returning buyer
            lambda v: has(v, lambda r: r["event_name"] == "add_payment_info") and not has(v, lambda r: r["event_name"] == "purchase"),       # payment drop-off
            lambda v: has(v, lambda r: r["event_name"] == "add_to_cart") and not has(v, lambda r: r["event_name"] == "begin_checkout"),     # cart abandon
            lambda v: has(v, lambda r: r["event_name"] == "generate_lead"),                     # lead
            lambda v: not has(v, lambda r: r["event_name"] not in ("experiment_view", "page_view")),  # browse only
        ]
        pick_ids = []
        for f in wanted[:sample_n]:
            vid = next((v for v in by if v not in pick_ids and f(v)), None)
            if vid: pick_ids.append(vid)
        dump(f"{base}/raw/events.sample.json", [r for r in ev_sorted if r["visitor_id"] in pick_ids])
        dump(f"{base}/raw/event_items.sample.json", [i for i in sim.items if i["visitor_id"] in pick_ids])
        dump(f"{base}/raw/exposures.view.sample.json", [x for x in expo if x["visitor_id"] in pick_ids])
    else:
        dump(f"{base}/raw/exposures.view.json", expo)
        dump(f"{base}/raw/events.json", ev_sorted)
        dump(f"{base}/raw/event_items.json", sim.items)


if __name__ == "__main__":
    # F1
    f1 = build_f1()
    M1 = model(f1, 1717, "2026-10-01", "2026-10-03", [100, 101], [0.5, 0.5])
    write_set("f1", f1, M1)
    r = report(M1, ["variation"], ALL, with_stats=False)  # internal check only
    t = {row["variation"]: row for row in r["totals"]}
    expect = {100: dict(visitors=3, purchasers=1, revenue=100.0, cr=1 / 3, aov=100.0, rpv=100 / 3, upsell_rate=0.0, cart_abandonment=0.0, basket_size=2.0, avg_item_price=50.0, units_sold=2, buy_to_cart=1.0, coupon_rate=0.0),
              101: dict(visitors=3, purchasers=2, revenue=145.0, cr=2 / 3, aov=62.5, rpv=145 / 3, upsell_rate=0.5, cart_abandonment=1.0, basket_size=1.5, avg_item_price=125 / 3, units_sold=4, buy_to_cart=0.0, coupon_rate=0.5, upsell_rpv=20 / 3)}
    for v, ex in expect.items():
        for k, val in ex.items():
            assert abs((t[v][k] or 0) - val) < 1e-6, (v, k, t[v][k], val)
    assert r["quality"] == {"multi_variation_visitors": 1, "variation_mismatch_events": 1}, r["quality"]
    dump(f"{HERE}/f1/modeled/products.json", products(M1))
    dump(f"{HERE}/f1/modeled/distributions.json", distributions(M1))
    dump(f"{HERE}/f1/modeled/health.json", health(M1))
    print("F1 ok: hand-computed values reproduced")
    # demo
    demo = build_demo()
    M = model(demo, 1717, "2026-10-01", "2026-10-14", [100, 101, 102], [1 / 3, 1 / 3, 1 / 3])
    write_set("demo", demo, M, sample_n=6)
    dump(f"{HERE}/demo/modeled/products.json", products(M))
    dump(f"{HERE}/demo/modeled/products.upsell.json", products(M, purchase_type="upsell"))
    dump(f"{HERE}/demo/modeled/distributions.json", distributions(M))
    dump(f"{HERE}/demo/modeled/health.json", health(M))
    print("demo:", len(demo.events), "events,", len(demo.items), "item rows,", len(M["exposed"]), "exposed visitors")


# ─────────────────────────── DAILY SUMMARY (v2 contract, supersedes `report`) ───────────────────────────
# One row per first-exposure date × variation × metric_key. Additive counters only; crobot sums a range
# and derives ratios (AOV = Σsum/Σcount of `purchase`, CR = Σconverted/Σvisitors, …).

SUMMARY_KEYS = ["purchase", "upsell", "revenue", "add_to_cart", "begin_checkout", "add_shipping_info", "add_payment_info",
                "generate_lead", "sign_up", "page_view", "units", "units_added", "units_bought_from_cart", "coupon",
                "lead", "lead_purchase", "repeat_purchase", "cart_purchase", "checkout_purchase", "session",
                "event:size_guide_opened", "goal:12"]


def summary_values(M, vid, capped=False):
    """Per visitor, per metric key: (converted 0/1, count, sum, [per-unit values for sum_sq], visitor total for sum_sq_visitor)."""
    es = M["att"].get(vid, [])
    by = defaultdict(list)
    for e in es: by[e["event_name"]].append(e)
    cap = M["cap"]
    def money(e):
        v = e["value_native"] * FX[e["currency"]]
        return min(v, cap) if capped and e["purchase_type"] in ("initial", "") else v
    init = [e for e in by["purchase"] if e["purchase_type"] in ("initial", "")]
    ups = [e for e in by["purchase"] if e["purchase_type"] == "upsell"]
    upsold = {e["parent_order_id"] for e in ups}
    lead = bool(by["generate_lead"] or by["sign_up"])
    carted = defaultdict(int); bought = defaultdict(int)
    for e in by["add_to_cart"]:
        for it in M["items"][e["event_id"]]: carted[it["product_id"]] += it["quantity"]
    for e in by["purchase"]:
        for it in M["items"][e["event_id"]]: bought[it["product_id"]] += it["quantity"]
    sess = {}
    for e in es:
        s0 = e["exp_session_starts"][e["exp_ids"].index(M["exp_id"])]
        sess[s0] = max(sess.get(s0, 0), parse_ts(e["client_ts"]).timestamp() - s0)
    unit_vals = [(it["price"] or 0) * FX[e["currency"]] for e in init for it in M["items"][e["event_id"]] for _ in range(it["quantity"])]
    def ev(name, vals=None):
        lst = by[name]; vals = vals if vals is not None else [e["value_native"] * FX[e["currency"]] if e["currency"] else 0 for e in lst]
        return (1 if lst else 0, len(lst), sum(vals), vals)
    out = {
        "purchase": (1 if init else 0, len(init), sum(money(e) for e in init), [money(e) for e in init]),
        "upsell": (1 if ups else 0, sum(1 for e in init if e["order_id"] in upsold), sum(money(e) for e in ups), [money(e) for e in ups]),
        "revenue": (1 if init or ups else 0, len(init) + len(ups), sum(money(e) for e in init + ups), [money(e) for e in init + ups]),
        "add_to_cart": ev("add_to_cart"), "begin_checkout": ev("begin_checkout"),
        "add_shipping_info": ev("add_shipping_info", []), "add_payment_info": ev("add_payment_info", []),
        "generate_lead": ev("generate_lead", []), "sign_up": ev("sign_up", []), "page_view": ev("page_view", []),
        "units": (1 if init else 0, len(unit_vals), sum(unit_vals), unit_vals),
        "units_added": (1 if carted else 0, sum(carted.values()), 0.0, []),
        "units_bought_from_cart": (1 if any(min(bought[p], carted[p]) for p in carted) else 0, sum(min(bought[p], carted[p]) for p in carted), 0.0, []),
        "coupon": (1 if any(e["props"].get("coupon") for e in init) else 0, sum(1 for e in init if e["props"].get("coupon")), 0.0, []),
        "lead": (1 if lead else 0, len(by["generate_lead"]) + len(by["sign_up"]), 0.0, []),
        "lead_purchase": (1 if lead and init else 0, 1 if lead and init else 0, 0.0, []),
        "repeat_purchase": (1 if len(init) >= 2 else 0, 1 if len(init) >= 2 else 0, 0.0, []),
        "cart_purchase": (1 if by["add_to_cart"] and init else 0, 1 if by["add_to_cart"] and init else 0, 0.0, []),
        "checkout_purchase": (1 if by["begin_checkout"] and init else 0, 1 if by["begin_checkout"] and init else 0, 0.0, []),
        "session": (1 if sess else 0, len(sess), sum(sess.values()), list(sess.values())),
        "event:size_guide_opened": ev("size_guide_opened", []),
        "goal:12": (1 if any(e["goal_id"] == 12 for e in by["conversion"]) else 0, sum(1 for e in by["conversion"] if e["goal_id"] == 12), 0.0, []),
    }
    return out


def daily_summary(M, keys=SUMMARY_KEYS, dimension=None, capped=False):
    acc = {}
    top = None
    if dimension:
        cnt = defaultdict(int)
        for x in M["exposed"].values(): cnt[x[dimension] or "(none)"] += 1
        top = {k for k, _ in sorted(cnt.items(), key=lambda kv: -kv[1])[:10]}
    vis = defaultdict(int)
    for vid, x in M["exposed"].items():
        dv = None
        if dimension:
            dv = x[dimension] or "(none)"; dv = dv if dv in top else "(other)"
        g = (x["date"], x["variation_id"], dv)
        vis[g] += 1
        vals = summary_values(M, vid, capped)
        for k in keys:
            c, n, s, units = vals[k]
            a = acc.setdefault(g + (k,), [0, 0, 0.0, 0.0, 0.0])
            a[0] += c; a[1] += n; a[2] += s; a[3] += sum(u * u for u in units); a[4] += s * s
    rows = []
    order = {v: i for i, v in enumerate(M["variations"])}
    for (d, var, dv, k), a in sorted(acc.items(), key=lambda kv: (kv[0][0], str(kv[0][2]), order[kv[0][1]], keys.index(kv[0][3]))):
        row = {"date": d, "variation_id": var}
        if dimension: row["dimension"] = dimension; row["dimension_value"] = dv
        row.update({"metric_key": k, "visitors": vis[(d, var, dv)], "converted": a[0], "count": a[1],
                    "sum": round(a[2], 2), "sum_sq": round(a[3], 2), "sum_sq_visitor": round(a[4], 2)})
        rows.append(row)
    return {"experiment_id": M["exp_id"], "from": M["frm"], "to": M["to"], "report_currency": M["ccy"],
            "date_basis": "first_exposure", "cap_outliers": capped, "dimension": dimension,
            "quality": {"multi_variation_visitors": M["multi"], "variation_mismatch_events": M["mismatch"]},
            "rows": rows}


def sum_range(rows, variation, key):
    rs = [r for r in rows if r["variation_id"] == variation and r["metric_key"] == key]
    vis = sum(r["visitors"] for r in rs)
    return vis, sum(r["converted"] for r in rs), sum(r["count"] for r in rs), sum(r["sum"] for r in rs)


if __name__ == "__main__":
    # F1 checks on the daily summary
    ds1 = daily_summary(M1)
    for v, ex in {100: dict(cr=1 / 3, aov=100.0, rpv=100 / 3), 101: dict(cr=2 / 3, aov=62.5, rpv=145 / 3)}.items():
        vis, conv, cnt, s = sum_range(ds1["rows"], v, "purchase"); _, _, _, rev = sum_range(ds1["rows"], v, "revenue")
        assert abs(conv / vis - ex["cr"]) < 1e-9 and abs(s / cnt - ex["aov"]) < 1e-9 and abs(rev / vis - ex["rpv"]) < 1e-9, (v, conv, vis, s, cnt, rev)
    dump(f"{HERE}/f1/modeled/daily_summary.json", ds1)
    ds = daily_summary(M)
    dump(f"{HERE}/demo/modeled/daily_summary.json", ds)
    dump(f"{HERE}/demo/modeled/daily_summary.device_type.json", daily_summary(M, dimension="device_type"))
    dump(f"{HERE}/demo/modeled/daily_summary.capped.json", daily_summary(M, keys=["purchase", "revenue"], capped=True))
    # crobot storage sample: the same rows as crobot keeps them in `metric_summary`
    dump(f"{HERE}/demo/backend/crobot_metric_summary.sample.json",
         [{"id": 900000 + i, "experiment_id": 1717, **{k: r[k] for k in ("date", "variation_id", "metric_key", "visitors", "converted", "count", "sum", "sum_sq", "sum_sq_visitor")},
           "updated_at": "2026-10-15 06:00:02"} for i, r in enumerate(ds["rows"][:57])])
    print("daily summary:", len(ds["rows"]), "rows; F1 CR/AOV/RPV reproduced from summed days")
