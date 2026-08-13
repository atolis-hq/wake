import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('target build lane', () => {
  it('builds the active target rather than an archived implementation', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts.build).toContain('tsconfig.json');
    expect(packageJson.scripts.build).not.toContain('archive/' + 'legacy');
  });

  it('initializes the Docker smoke root before ticking it', async () => {
    const workflow = await readFile('.github/workflows/ci-cd.yml', 'utf8');

    expect(workflow).toContain('/app/dist/src/main.js init /tmp/wake-smoke');
    expect(workflow).toContain(
      '/app/dist/src/main.js tick --wake-root /tmp/wake-smoke --no-sandbox',
    );
  });
});
