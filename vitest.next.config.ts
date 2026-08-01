import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test-next/**/*.test.ts'],
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
