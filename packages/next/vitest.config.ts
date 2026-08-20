import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The server entry imports the client entry via the bare self-reference
  // `@testa-soft/next/experiments` (kept external so the "use client" boundary
  // survives the build). Point that at the source under test so vitest resolves
  // it without a built `dist`.
  resolve: {
    alias: {
      '@testa-soft/next/experiments': fileURLToPath(
        new URL('./src/experiments/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'node',
    globals: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/__tests__/**', 'src/index.ts', 'src/middleware.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
    include: ['src/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
  },
});
