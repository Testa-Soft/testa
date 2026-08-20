import { defineConfig } from 'tsup';

// Self-contained, publishable bundle: workspace deps (experiment-core, dom,
// shared-types) are INLINED so consumers install just `@testa/next` (with `next`
// + `react` as peers).
//
// Entry boundaries:
//   - `index`        — server/edge middleware surface (react-free, no directive).
//   - `router-guard` — `<TestaRouterGuard/>` client component.
//   - `experiments`  — `<TestaExperiments/>` + `<TestaShield/>` client entry.
//   - `server`       — RSC surface (async server components, NO directive). It
//                      imports the client entry via the bare self-reference
//                      `@testa-soft/next/experiments` (kept EXTERNAL below) so the
//                      client bundle's `"use client"` boundary survives the build.
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
  ],
  format: ['esm', 'cjs'],
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
    // Self-reference: the server entry imports the client entry through it so the
    // client `"use client"` boundary is not inlined into the server bundle.
    '@testa-soft/next/experiments',
  ],
});
