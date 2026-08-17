import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    globals: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/__tests__/**', 'src/index.ts'],
      thresholds: {
        lines: 80,
        branches: 75,
      },
    },
    include: ['src/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
  },
});
