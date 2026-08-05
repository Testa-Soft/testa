import { defineConfig } from 'tsup';

// Builds a self-contained, publishable bundle: the workspace deps
// (experiment-core, shared-types) are INLINED so external consumers install just
// `@testa/next` (with `next` as the only peer).
export default defineConfig({
  // `index` is the server/edge middleware surface (react-free). `router-guard`
  // is the optional client `<TestaRouterGuard/>` entry — kept separate so the
  // middleware bundle never pulls in react / next/router.
  entry: ['src/index.ts', 'src/router-guard/index.ts'],
  format: ['esm', 'cjs'],
  // Override the base tsconfig's `incremental` (tsup's dts tsc rejects it).
  dts: { compilerOptions: { incremental: false, composite: false } },
  clean: true,
  sourcemap: true,
  treeshake: true,
  // Bundle the workspace packages into the output; keep next/react external (peers).
  noExternal: [/@testa-platform\//],
  external: ['next', 'react'],
});
