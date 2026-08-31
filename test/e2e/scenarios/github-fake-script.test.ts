import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('target fake-GitHub E2E script policy', () => {
  it('exposes a runnable target script without importing legacy source', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    const source = await readFile('scripts/e2e-github-fake.ts', 'utf8');
    expect(packageJson.scripts['e2e:github-fake']).toBe(
      'tsx --tsconfig tsconfig.source.json scripts/e2e-github-fake.ts',
    );
    expect(source).not.toContain('archive/' + 'legacy');
    expect(source).toContain('../src/main.js');
  });
});
