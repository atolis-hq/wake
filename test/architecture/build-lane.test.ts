import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('target build lane', () => {
  it('builds the active target rather than an archived implementation', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts.build).toContain('tsconfig.json');
    expect(packageJson.scripts.build).not.toContain('archive/' + 'legacy');
    expect(packageJson.scripts).not.toHaveProperty('build:next');
  });
});
