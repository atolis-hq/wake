import { defineConfig } from 'vitest/config';
import { workspaceSourceAliases } from './vitest.workspace-aliases.js';

export default defineConfig({
  resolve: { alias: workspaceSourceAliases },
  test: {
    environment: 'node',
    include: ['test/integration/**/*.test.ts'],
    // Durable filesystem fixtures can exceed Vitest’s 5s default on CI runners.
    testTimeout: 30_000,
    fileParallelism: true,
    // File-backed fixtures contend on fsync-backed locks when all CPUs are workers.
    maxWorkers: 4,
  },
});
