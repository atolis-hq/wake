import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/e2e/scenarios/live-*.test.ts'],
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
