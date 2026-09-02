import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const readRepositoryFile = (path: string): Promise<string> =>
  readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

describe('developer tooling', () => {
  it('uses native cross-platform hooks, cached linting, and bounded Vitest workers', async () => {
    const [packageJsonText, lefthook, integrationVitest, webVitest] = await Promise.all([
      readRepositoryFile('package.json'),
      readRepositoryFile('lefthook.yml'),
      readRepositoryFile('vitest.integration.config.ts'),
      readRepositoryFile('src/surfaces/web/vitest.config.ts'),
    ]);
    const packageJson = JSON.parse(packageJsonText) as {
      devDependencies: Record<string, string>;
      scripts: Record<string, string>;
      'lint-staged'?: unknown;
    };

    expect(packageJson.devDependencies).toHaveProperty('lefthook');
    expect(packageJson.devDependencies).not.toHaveProperty('husky');
    expect(packageJson.devDependencies).not.toHaveProperty('lint-staged');
    expect(packageJson).not.toHaveProperty('lint-staged');
    expect(packageJson.scripts).not.toHaveProperty('prepare');
    expect(packageJson.scripts.lint).toBe(
      'eslint --cache --cache-strategy content --cache-location node_modules/.cache/eslint/.eslintcache .',
    );
    expect(lefthook).toContain("glob: '*.{ts,tsx,js,mjs,cjs,json,yaml,yml,css,html}'");
    expect(lefthook).toContain('stage_fixed: true');
    expect(lefthook).toContain(
      'node node_modules/prettier/bin/prettier.cjs --write {staged_files}',
    );
    expect(integrationVitest).toContain('maxWorkers: 4');
    expect(webVitest).toContain('maxWorkers: 4');
  });
});
