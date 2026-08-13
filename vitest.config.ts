import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['test/e2e/scenarios/live-*.test.ts'],
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
