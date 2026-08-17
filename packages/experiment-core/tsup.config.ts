import { defineConfig } from 'tsup';

// Host-neutral decision core. `@testa-platform/shared-types` is types-only, so
// it's inlined into the emitted `.d.ts` (rollup-dts bundles it) and contributes
// no runtime code — the published package has no runtime dependencies.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: { compilerOptions: { incremental: false, composite: false } },
  clean: true,
  sourcemap: true,
  treeshake: true,
});
