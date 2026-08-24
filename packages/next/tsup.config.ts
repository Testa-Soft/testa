import { defineConfig } from 'tsup';

// Self-contained, publishable bundle: workspace deps (experiment-core, dom,
// shared-types) are INLINED so consumers install just `@testa/next` (with `next`
// + `react` as peers).
//
// Entry boundaries:
//   - `index`        — server/edge middleware surface (react-free, no directive).
//   - `router-guard` — `<TestaRouterGuard/>` client component.
//   - `experiments`  — INTERNAL client half of the `/server` components. Exposed
//                      only as `./_internal/experiments` (the self-reference
//                      below needs an exports-map entry); not a public API.
//   - `server`       — RSC surface (async server components, NO directive). It
//                      imports the client entry via the bare self-reference
//                      `@testa-soft/next/_internal/experiments` (kept EXTERNAL
//                      below) so the client bundle's `"use client"` boundary
//                      survives the build.
//
// The two client entries need a `"use client"` directive at the top of the
// shipped file, but esbuild strips module-level directives when bundling. So the
// `build` script prepends it AFTER tsup (scripts/add-use-client.mjs). The
// middleware bundle stays free of react + the DOM apply engine (verified in CI).
export default defineConfig({
  entry: [
    'src/index.ts',
    'src/router-guard/index.ts',
    'src/experiments/index.ts',
    'src/server/index.ts',
    // Node-only config poller (`registerTestaConfig`) for instrumentation.ts.
    'src/instrumentation/index.ts',
    // Pages Router surface: client provider + self-wired router guard.
    'src/pages/index.ts',
  ],
  format: ['esm', 'cjs'],
  // NO shared chunks — every entry is self-contained. Bundlers with partial
  // externalization (Next transpilePackages over a symlinked package) have
  // been seen leaving `require('../chunk-*.js')` unresolved at runtime; a few
  // KB of duplicated helper code beats that whole failure class. Cross-entry
  // state deliberately lives on `globalThis` (config-snapshot.ts), so
  // duplicated modules stay coherent.
  splitting: false,
  dts: { compilerOptions: { incremental: false, composite: false } },
  clean: true,
  sourcemap: true,
  treeshake: true,
  // shared-types is types-only → bundle it (inlined into the dts). The engine
  // packages are real runtime dependencies now (@testa-soft/experiment-core +
  // @testa-soft/dom), so keep them EXTERNAL — consumers install them alongside
  // @testa-soft/next, no duplicated engine code.
  noExternal: [/@testa-platform\/shared-types/],
  external: [
    'next',
    'react',
    '@testa-soft/experiment-core',
    '@testa-soft/dom',
    // Real runtime dep of the `/pages` entry (client engine); consumers get it
    // via our dependencies — never inline it (it ships its own "use client").
    '@testa-soft/react',
    // Self-reference: the server entry imports the client entry through it so the
    // client `"use client"` boundary is not inlined into the server bundle.
    '@testa-soft/next/_internal/experiments',
  ],
});
