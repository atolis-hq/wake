import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('package scripts', () => {
  it('keeps the real-Git integration suite out of the default test loop and in CI', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts.test).toContain(
      '--exclude test/adapters/git-workspace-manager.test.ts',
    );
    expect(packageJson.scripts['test:integration']).toBe(
      'vitest run test/adapters/git-workspace-manager.test.ts',
    );
    expect(packageJson.scripts['verify:ci']).toBe(
      'npm run verify && npm run verify:next && npm run test:integration && npm run test:next:e2e',
    );
  });
});
