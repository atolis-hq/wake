import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFile(new URL(`../../../${path}`, import.meta.url), 'utf8');

describe('target test tiers', () => {
  it('keeps unit, integration, and E2E runner ownership disjoint', async () => {
    const packageJson = JSON.parse(await read('package.json')) as { scripts: Record<string, string> };
    const [unit, integration, e2e, live] = await Promise.all([
      read('vitest.next.unit.config.ts'),
      read('vitest.next.integration.config.ts'),
      read('vitest.next.e2e.config.ts'),
      read('vitest.next.live-e2e.config.ts'),
    ]);

    expect(packageJson.scripts['test:next']).toBe('npm run test:next:unit');
    expect(packageJson.scripts['verify:next']).toContain('npm run test:next:unit');
    expect(packageJson.scripts['verify:next']).not.toContain('test:next:integration');
    expect(packageJson.scripts['verify:next']).not.toContain('test:next:e2e');
    expect(packageJson.scripts['verify:ci']).toContain('npm run test:next:integration');
    expect(packageJson.scripts['verify:ci']).toContain('npm run test:next:e2e');
    expect(unit).toContain("include: ['test-next/unit/**/*.test.ts']");
    expect(integration).toContain("include: ['test-next/integration/**/*.test.ts']");
    expect(e2e).toContain("include: ['test-next/e2e/**/*.test.ts']");
    expect(e2e).toContain("exclude: ['test-next/e2e/scenarios/live-*.test.ts']");
    expect(live).toContain("include: ['test-next/e2e/scenarios/live-*.test.ts']");
  });
});