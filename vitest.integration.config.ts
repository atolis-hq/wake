import { defineConfig } from 'vitest/config';
import { workspaceSourceAliases } from './vitest.workspace-aliases.js';

export default defineConfig({
  resolve: { alias: workspaceSourceAliases },
  test: {
    environment: 'node',
    // Durable filesystem fixtures can exceed Vitest's five-second default under suite load.
    testTimeout: 30_000,
    include: ['test/integration/**/*.test.ts'],
    fileParallelism: true,
    // File-backed fixtures contend on fsync-backed locks when all CPUs are workers.
    maxWorkers: 4,
  },
});
