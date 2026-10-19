import { defineConfig } from 'vitest/config';
import { workspaceSourceAliases } from './vitest.workspace-aliases.js';

// Resource-exhaustion regressions run on purpose only (`npm run test:stress`):
// they deliberately starve a child process of memory and are slow.
export default defineConfig({
  resolve: { alias: workspaceSourceAliases },
  test: {
    environment: 'node',
    include: ['test/stress/**/*.stress.ts'],
    testTimeout: 300_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
