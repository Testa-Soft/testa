# @testa-soft/experiment-core

The host-neutral **decision core** for Testa experiments. Given a project config
and a request context, it decides *which variation a visitor gets* — deterministic
bucketing, sticky assignment via a packed cookie, split-URL redirect resolution,
targeting/exclusion evaluation, and cross-domain assignment transfer. It touches
no framework and no DOM, so it runs identically in the Edge Runtime, Node, and
the browser.

> **You usually don't install this directly.** It's the shared engine behind the
> framework integrations — [`@testa-soft/next`](https://www.npmjs.com/package/@testa-soft/next)
> and the client SDK. Install one of those instead; this comes along as a
> dependency. It's published so the integrations can share one implementation
> (no duplicated bucketing logic → a visitor buckets identically everywhere).

## What's inside

- **Deterministic bucketing** — `assign()`, `bucketOf()`, `pickByWeight()` (xxhash32 of `visitorId:experimentId`, mod 100; no `Math.random()` → no sample-ratio mismatch).
- **Sticky assignment** — one packed `_testa_exp` cookie (`parsePacked`/`serializePacked`), read cookie-first so a returning visitor never re-rolls.
- **Split-URL redirects** — `decideRedirect` / `resolveRedirectDestination` / `buildRedirectUrl` with `exact`/`contains`/`regex`/`query` match modes + `matchesForMode`.
- **Targeting & exclusions** — `passesTargeting` (AND) / `isExcludedByRules` (OR) over UTM, url, cookie, device, and geo dimensions.
- **Cross-domain** — `encodeCrossDomainData` / `decodeCrossDomain` to carry an assignment across domains.
- **`CookieStore`** — the tiny read/write cookie interface each host adapter implements.

## Install

```bash
npm install @testa-soft/experiment-core
```

Ships ESM + CJS + types. No runtime dependencies.

## License

UNLICENSED — © testa-soft.
