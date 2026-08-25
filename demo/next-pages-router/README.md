# Pages Router demo — `@testa-soft/next/pages`

The Pages Router twin of `../next-split-url` (App Router). Two files carry the
whole integration: `middleware.ts` (`createTestaProxy` — server-side split-URL
307s) and `pages/_app.tsx` (`<TestaProvider/>` from `@testa-soft/next/pages` —
client engine + soft-nav router guard, self-wired).

```sh
pnpm install   # from the repo root
pnpm --filter @testa-demo/next-pages-router dev   # → http://localhost:3300
```

Things to try:

1. **Hard-load redirect** — open http://localhost:3300/pricing. ~50% of fresh
   visitors get a server-side 307 to `/pricing-v2` (Network tab; sticky via the
   `_testa_exp` cookie — clear it or use a private window to re-roll).
2. **Soft-nav guard** — from the home page, click the *soft nav* pricing link.
   A variant-bucketed visitor lands on `/pricing-v2` without the control page
   ever rendering, even though the navigation never touched the server.
3. **DOM change** — the H1 gets a ✨ badge (experiment 202) on every page,
   applied client-side and re-applied across navigations.
4. **Server hook** — the dev-server terminal logs `[testa][server]
   variation_assigned …` per assignment.

## Watching the anti-flicker shield (slow mode)

The shield is invisible when it works, and with an inline config it's up for a
couple of milliseconds. Slow mode makes it a 2-second hold you can watch:

```sh
pnpm --filter @testa-demo/next-pages-router build:slow
pnpm --filter @testa-demo/next-pages-router start:slow   # → http://localhost:3300
```

`<TestaProvider/>` then fetches from the demo's own `/api/v1/config/[projectId]`
route, which sleeps 2s (`?delay=5000` to stall longer). Reload the page: it is
held **blank for ~2s and paints the variant first** — the ✨ badge is there in
the first frame you see, and the control H1 is never shown. Then compare:

- `shield={false}` in `pages/_app.tsx` → the control paints immediately and the
  badge pops in 2s later. That's the flash the shield exists to prevent.
- View source, or look in `<head>`: `<style id="__testa_shield_css">` is in the
  **server-rendered HTML**. That's why there's nothing to flash — it's in place
  before the browser paints, which no client-side effect can achieve.
- Disable JavaScript and load the page: the CSS reveals itself after the
  timeout, so a broken bundle can't leave the site hidden.

> Use the **production** build for this. `next dev` hides the body itself
> (Next's own FOUC guard), which masks exactly what you're trying to see. Slow
> mode is compiled in via `NEXT_PUBLIC_TESTA_SLOW_MS`, hence `build:slow` before
> `start:slow`.
