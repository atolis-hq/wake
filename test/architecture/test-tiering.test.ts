import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

describe('target test tiers', () => {
  it('keeps unit, architecture, integration, and E2E runner ownership disjoint', async () => {
    const packageJson = JSON.parse(await read('package.json')) as {
      scripts: Record<string, string>;
    };
    const [unit, architecture, integration, e2e, live] = await Promise.all([
      read('vitest.unit.config.ts'),
      read('vitest.architecture.config.ts'),
      read('vitest.integration.config.ts'),
      read('vitest.e2e.config.ts'),
      read('vitest.live-e2e.config.ts'),
    ]);

    expect(packageJson.scripts.test).toBe('vitest run');
    expect(packageJson.scripts.verify).toContain('npm test');
    expect(packageJson.scripts).not.toHaveProperty('test:next');
    expect(packageJson.scripts).not.toHaveProperty('verify:next');
    expect(unit).toContain("include: ['test/unit/**/*.test.ts']");
    expect(architecture).toContain("include: ['test/architecture/**/*.test.ts']");
    expect(architecture).toContain('fileParallelism: false');
    expect(integration).toContain("include: ['test/integration/**/*.test.ts']");
    expect(e2e).toContain("include: ['test/e2e/**/*.test.ts']");
    expect(e2e).toContain("exclude: ['test/e2e/scenarios/live-*.test.ts']");
    expect(live).toContain("include: ['test/e2e/scenarios/live-*.test.ts']");
  });
});
