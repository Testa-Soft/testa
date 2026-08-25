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
