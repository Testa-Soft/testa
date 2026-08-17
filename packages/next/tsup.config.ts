import { defineConfig } from 'tsup';

// Self-contained, publishable bundle: workspace deps (experiment-core, dom,
// shared-types) are INLINED so consumers install just `@testa/next` (with `next`
// + `react` as peers).
//
// Entry boundaries:
//   - `index`        — server/edge middleware surface (react-free, no directive).
//   - `router-guard` — `<TestaRouterGuard/>` client component.
//   - `experiments`  — `<TestaExperiments/>` + `<TestaShield/>` client entry.
//
// The two client entries need a `"use client"` directive at the top of the
// shipped file, but esbuild strips module-level directives when bundling. So the
// `build` script prepends it AFTER tsup (scripts/add-use-client.mjs). The
// middleware bundle stays free of react + the DOM apply engine (verified in CI).
export default defineConfig({
  entry: ['src/index.ts', 'src/router-guard/index.ts', 'src/experiments/index.ts'],
  format: ['esm', 'cjs'],
  dts: { compilerOptions: { incremental: false, composite: false } },
  clean: true,
  sourcemap: true,
  treeshake: true,
  noExternal: [/@testa-platform\//],
  external: ['next', 'react'],
});
