import { defineConfig } from 'vitest/config';
import { workspaceSourceAliases } from '../../vitest.workspace-aliases.js';

export default defineConfig({
  resolve: { alias: workspaceSourceAliases },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
