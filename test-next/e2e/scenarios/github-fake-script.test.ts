import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('target fake-GitHub E2E script policy', () => {
  it('exposes a runnable target script without importing legacy source', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    const source = await readFile('scripts-next/e2e-github-fake.ts', 'utf8');
    expect(packageJson.scripts['e2e:github-fake:next']).toBe('tsx scripts-next/e2e-github-fake.ts');
    expect(packageJson.scripts['e2e:github-fake:legacy']).toBe('tsx scripts/e2e-github-fake.ts');
    expect(source).not.toMatch(/\.\.\/src\//);
    expect(source).toContain('../src-next/main.js');
  });
});
