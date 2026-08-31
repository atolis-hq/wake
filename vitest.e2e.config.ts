import { defineConfig } from 'vitest/config';
import { workspaceSourceAliases } from './vitest.workspace-aliases.js';

export default defineConfig({
  resolve: { alias: workspaceSourceAliases },
  test: {
    environment: 'node',
    include: ['test/e2e/**/*.test.ts'],
    exclude: ['test/e2e/scenarios/live-*.test.ts'],
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
