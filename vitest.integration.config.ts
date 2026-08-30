import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/integration/**/*.test.ts'],
    fileParallelism: true,
    // File-backed fixtures contend on fsync-backed locks when all CPUs are workers.
    maxWorkers: 4,
  },
});
