---
id: "P.3"
title: "Publish @testa/next to npm + client integration README"
phase: "P"
status: pending
estimate_days: 0.5
blocked_by: []
files_to_create:
  - packages/next/README.md
references:
  - packages/next/package.json
  - packages/next/tsup.config.ts
  - decision_prod_hardening (memory)
commits: []
completed_at: null
---

## Goal

Ship `@testa/next` on npm so clients `npm install @testa/next` and integrate with
one line.

## Context

Publish prep is DONE: tsup builds a self-contained `dist` (ESM+CJS+dts) with
`experiment-core` + `shared-types` INLINED and `next` as the only peer; package.json
has dist entry points, `exports`, `files:["dist"]`, `prepublishOnly`. Still
`private: true` — the maintainer removes it and publishes with their npm creds
(the agent can't).

Client integration is just:
```ts
// middleware.ts
import { createTestaMiddleware } from '@testa/next'
export const middleware = createTestaMiddleware({ projectId: 'their-uuid' })
export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico|api).*)'] }
```

DEV NOTE: while unpublished, the demo consumes the built `dist`, so editing
`@testa/next` OR `experiment-core` needs `pnpm --filter @testa/next build` to
reflect. Consider a turbo `build` dependency or a `development` export condition
to restore src hot-reload for local work.

## Acceptance criteria

- [ ] `packages/next/README.md`: install, the one-line middleware, `matcher`,
      options (`projectId`, `host`, `tracking`, `cookieDomain`, `discoverRootDomain`,
      `onVariationApplied`), and the `DEFAULT_CONFIG_HOST`/`TESTA_CONFIG_HOST` story.
- [ ] Set the `@testa` scope owner + a real version; `npm publish --access public`
      (or restricted) verified via `npm pack` dry-run (tarball contains only `dist` + README).
- [ ] `@testa/next` `dependencies` are empty at publish (deps inlined); `next` peer only.
- [ ] Remove `private: true` as the final step.
