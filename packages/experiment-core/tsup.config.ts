import { defineConfig } from 'tsup';

// Host-neutral decision core. `@testa-platform/shared-types` is private and
// mostly types (inlined into the emitted `.d.ts` by rollup-dts); its small
// runtime part — the PII scrubbers — is bundled in via `noExternal`, so the
// published package still has no runtime dependencies.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: { compilerOptions: { incremental: false, composite: false } },
  clean: true,
  sourcemap: true,
  treeshake: true,
  noExternal: [/@testa-platform\/shared-types/],
});
