import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test-next/**/*.test.ts'],
    exclude: ['test-next/e2e/scenarios/live-*.test.ts'],
  },
});
