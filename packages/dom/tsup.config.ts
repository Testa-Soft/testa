import { defineConfig } from 'tsup';

// Browser render layer. `@testa-platform/shared-types` is types-only → inlined
// into the emitted `.d.ts`, no runtime dependency. Browser-only (DOM/MutationObserver)
// but that's a runtime concern; the bundle itself is framework-agnostic.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: { compilerOptions: { incremental: false, composite: false } },
  clean: true,
  sourcemap: true,
  treeshake: true,
});
