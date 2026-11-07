# Architecture — Cookies & consent

## The problem we're solving

**Safari ITP** caps `document.cookie` (JS-set cookies) at 7 days and enforces aggressive third-party cookie blocking. **Firefox ETP** does similar via Total Cookie Protection. The current 3.6 pixel sets `_testa_uuid` via `document.cookie`, so a "returning visitor 30 days later" appears as a fresh visitor on Safari — destroying any cohort metric (AOV, RPV) that depends on visitor continuity.

The fix industry-wide (VWO, Optimizely, AB Tasty, Convert, PostHog, Plausible, Fathom): a server proxy on the customer's domain that sets `_testa_uuid` via `Set-Cookie` from a **first-party context**. JS is forbidden from setting it.

## Two cookie modes

### Shared domain (default, "good enough" mode)

```
Browser → https://track.testa.com/projects/foo.js → Worker
             ↑ cookies set here are third-party from customer's site
```

Worker sets `Set-Cookie: _testa_uuid=...; Domain=.testa.com; Max-Age=63072000; SameSite=Lax; Secure`. Cookie persists on Chrome / older browsers but Safari and Firefox classify it as third-party and block / shorten.

Acceptable for many customers. New projects default here.

### CNAME first-party mode (opt-in)

```
Browser → https://track.{customer-domain}/projects/foo.js → CNAME → Worker
             ↑ cookies set here are first-party from customer's site
```

Customer adds DNS:

```
track.{customer-domain}.   CNAME   testa-edge.workers.dev.
```

Worker recognizes the host (matched against the project's `tracking_domain` setting) and sets `Set-Cookie: _testa_uuid=...; Domain=.{customer-domain}; Max-Age=63072000; SameSite=Lax; Secure`.

**Cookie is first-party from the customer's site. Survives ITP. 2-year persistence.**

The customer decides per-project. We expose a "First-Party Tracking" setting in the Filament admin with copy/paste DNS instructions.

## Cookie inventory

| Cookie | Set by | Max-Age | Purpose | First-party? |
|---|---|---|---|---|
| `_testa_uuid` | Worker (Set-Cookie) | 2 years | Persistent visitor id | Depends on mode |
| `_testa_ses` | Pixel JS (document.cookie) | 1 hour sliding | Session id (TTL refreshes on activity) | Always (same eTLD+1) |
| `_testa_exp` | Pixel JS (document.cookie) | 30 days | Experiment assignment cache | Always |
| `_testa_excl` | Pixel JS (document.cookie) | 30 days | Excluded visitors (rule-based bypass) | Always |

Why `_testa_ses` and `_testa_exp` stay JS-set: they're per-session / per-experiment ephemeral. The 7-day ITP cap matters less than for `_testa_uuid` (persistence is the headline win).

## Consent in the SDKs (`@testa-soft/next`, `@testa-soft/react`) — GDPR, 2026-11-07

The SDKs are the live integration; the per-state table further down describes the
`apps/pixel` runtime only.

**Default is session-scoped.** Until the customer reports `'granted'`, nothing we
store outlives the browser session:

| | not granted (`unknown` / `denied`, the default) | `granted` |
|---|---|---|
| `_testa_uuid`, `_testa_uuid_s`, `_testa_exp` | **session cookies** (no `Max-Age`) | full lifetime (400 d / 30 d) |
| Client mirror | `sessionStorage` only, never `localStorage` | `localStorage` (+ `sessionStorage` fallback) |
| Short cookies (`_testa_sid` 30 min, redirect guard 15 s) | keep their own `Max-Age` (≤ 1 day) | same |
| Edge `/track` `_testa_uuid` | session cookie | 2-year cookie |

Session cookies rather than sessionStorage alone so that the middleware still sees
the id + assignment: server-side split-URL redirects keep working and every tab of
the session lands in the same variation. Bucketing is `hash(visitorId:experimentId)`,
so within a session nothing changes; only cross-session continuity is lost.

**Signalling consent** (customer-set, read per request / per render):

```ts
createTestaProxy({ projectId, consent: (req) => (req.cookies.get('cmp')?.value === 'yes' ? 'granted' : 'denied') });
<TestaProvider projectId={…} consent={cmpAccepted ? 'granted' : 'denied'} />
setConsent('granted'); // from a CMP callback outside React
```

**Promotion, not re-minting.** On grant the values already held are re-written with
their full lifetime — same id, same variation. On revoke they are demoted back and the
`localStorage` copies removed. The `_testa_persist` marker (`p`/`s`) records which
lifetime the values were last written with, because neither side can read a cookie's
expiry back. It also lets one side lead: a side that was not told (`consent` omitted /
resolver returned nothing) follows the marker the other side wrote, so a client-only or
server-only integration never ping-pongs. An explicit answer always wins. Cookies from
before this release carry no marker and are demoted once.

Legal note: under ePrivacy Art. 5(3) session cookies / sessionStorage still need
consent unless strictly necessary. Session scoping minimises the data; it does not by
itself exempt a site from its CMP.

## Consent (legacy `apps/pixel` runtime)

We are **consent-aware but not gated**. The pixel always fires; what changes is what we persist and for how long.

### Default state: `granted`

Matches GA4's default. Fits the most common customer integration (no CMP, or CMP-after-load).

### Customer signals via API

```js
window._testa.consent('granted')   // default
window._testa.consent('denied')    // anonymize
window._testa.consent('unknown')   // partial: persist visitor_id but mark
```

Or via DOM event (CMP integration):

```js
window.dispatchEvent(new CustomEvent('cmp:consent-changed', { detail: 'denied' }));
```

Pixel listens for this event and routes it to the consent module.

### What changes per state

| Behavior | granted | unknown | denied |
|---|---|---|---|
| `_testa_uuid` cookie set | Yes (2y) | Yes (2y) | **No** (Max-Age=0) |
| `visitor_id` derivation | from `_testa_uuid` | from `_testa_uuid` | **rotated daily**: `SHA-256(salt_of_day || ip || ua)` |
| IP forwarded to collector | yes | yes | **truncated** (last octet IPv4 / last 80 bits IPv6) |
| `consent_state` field in CH | 'granted' | 'unknown' | 'denied' |

Daily-rotating `visitor_id` means a denied visitor cannot be tracked across days. Within a day they're consistent (so bounce/sessions work for that day). After UTC midnight they get a fresh id.

The salt rotation: a random `VISITOR_ID_SALT` env var on the worker plus the UTC date string, both fed into SHA-256. The salt is rotated yearly via a wrangler secret update. Salt is never persisted alongside the hash, so even if CH is leaked, original ids cannot be recovered.

## Privacy / compliance posture

- **Roles.** Customer is data controller. We are processor (per DPA, mirrors VWO/Optimizely/AB Tasty industry baseline).
- **Retention.** 13 months on raw events (CH TTL on partition); aggregates indefinite. Aligns with CNIL recommendation for analytics with consent.
- **Data subject requests.** Per DPA, customer routes deletion / export requests; we honour them by `visitor_id`. With denied-state daily rotation, denied-visitor data is automatically forgotten after 1 day in any practical sense.
- **No PII in events — enforced.** Personal data is STRIPPED (the event is kept) at every hop: the SDKs before sending, the edge `/track` validator, and the collector `/_ingest` (shared rules: `packages/shared-types/src/pii.ts`). PII-named fields (email, phone, names, address, IP, …) and email-bearing values are dropped from props / items / passthrough fields; PII query params are dropped from `url` / `referrer` / `entry_*`; emails in titles and URL paths are redacted. The same scrub applies to the crobot `/api/leads` (exposure) and `/api/leads/convert` (goal `data`) payloads.
- **No IP addresses.** ClickHouse has no IP column (geo comes from CF headers). The Next middleware no longer forwards the visitor IP (`x-forwarded-for`) to crobot `/api/leads`.

## Implementation references

- Worker cookie module: `apps/edge/src/cookies.ts`
- Pixel consent module: `apps/pixel/src/runtime/consent.ts`
- Visitor id rotation: `apps/edge/src/visitor.ts`
- IP truncation: `apps/edge/src/enrich.ts`
- Project `tracking_domain` setting: stored in crobot `projects` table, published to KV, read by worker.
