import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/architecture/**/*.test.ts'],
    fileParallelism: false,
  },
});
