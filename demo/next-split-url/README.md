# Testa split-URL demo (`@testa-soft/next`)

A minimal Next.js App Router app wired to the Testa split-URL middleware.

## What it shows

An active 50/50 split-URL experiment on `/pricing`:

- ~half of visitors are **redirected server-side (307)** to `/pricing-v2` before
  any HTML is sent — **zero flicker**;
- the other half see `/pricing` (control);
- the assignment is **sticky** (`_testa_exp` cookie) and the visitor id is
  first-party (`_testa_uuid`), both set by the middleware.

Config is inline in `testa.config.ts`. In production it comes from crobot (CDN
hashed JSON / Edge Config) — see `docs/prds/003-nextjs-redirect-middleware.md`.

## Run

```sh
pnpm install
pnpm --filter @testa-demo/next-split-url dev   # http://localhost:3100
```

## Prove it from the CLI

```sh
# Force the variant bucket via a seeded assignment cookie → 307 to /pricing-v2
curl -sI --cookie '_testa_exp=101.2.0.0' http://localhost:3100/pricing | grep -i '^location'

# Force control → 200, no redirect
curl -sI --cookie '_testa_exp=101.1.0.0' http://localhost:3100/pricing | grep -i 'HTTP/'

# Fresh visitor → deterministic bucket; a _testa_uuid cookie is minted
curl -sI http://localhost:3100/pricing | grep -i 'set-cookie'
```
