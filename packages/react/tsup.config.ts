import { defineConfig } from 'tsup';

// Self-contained, publishable bundle: `shared-types` is types-only so it's
// INLINED into the dts; the engine packages (`@testa-soft/experiment-core` +
// `@testa-soft/dom`) and `react` stay EXTERNAL so consumers install them
// alongside `@testa-soft/react` with no duplicated engine code.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: { compilerOptions: { incremental: false, composite: false } },
  clean: true,
  sourcemap: true,
  treeshake: true,
  noExternal: [/@testa-platform\/shared-types/],
  external: ['react', '@testa-soft/experiment-core', '@testa-soft/dom'],
});
