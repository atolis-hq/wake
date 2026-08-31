import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

describe('target test tiers', () => {
  it('keeps unit, architecture, integration, and E2E runner ownership disjoint', async () => {
    const packageJson = JSON.parse(await read('package.json')) as {
      scripts: Record<string, string>;
    };
    const [unit, architecture, integration, e2e, live, workflow] = await Promise.all([
      read('vitest.unit.config.ts'),
      read('vitest.architecture.config.ts'),
      read('vitest.integration.config.ts'),
      read('vitest.e2e.config.ts'),
      read('vitest.live-e2e.config.ts'),
      read('.github/workflows/ci-cd.yml'),
    ]);

    expect(packageJson.scripts.test).toBe('npm run test:unit');
    expect(packageJson.scripts['test:unit']).toBe(
      'npm --workspace @atolis-hq/eventing test && npm --workspace @atolis-hq/eventing-filesystem test && npm run test:unit:wake',
    );
    expect(packageJson.scripts['test:unit:wake']).toBe('vitest run --config vitest.unit.config.ts');
    expect(packageJson.scripts.verify).toContain('npm run check:specs');
    expect(packageJson.scripts['check:specs:report']).toBe('node scripts/report-spec-drift.mjs');
    expect(packageJson.scripts.verify).toContain('npm run check:specs:report');
    expect(packageJson.scripts.verify).toContain('npm run build');
    expect(packageJson.scripts.verify).toContain('npm run test:unit');
    expect(packageJson.scripts.verify).toContain('npm run check:source-resolution');
    expect(packageJson.scripts).toHaveProperty('verify:ci');
    expect(packageJson.scripts['verify:ci']).toContain('npm run test:architecture');
    expect(packageJson.scripts['verify:ci']).toContain('npm run test:integration');
    expect(packageJson.scripts['verify:ci']).toContain('npm run test:e2e');
    expect(packageJson.scripts['verify:ci']).toContain('npm run knip');
    expect(packageJson.scripts['verify:ci']).toContain('npm run test:web');
    expect(packageJson.scripts).not.toHaveProperty('test:next');
    expect(packageJson.scripts).not.toHaveProperty('verify:next');
    expect(unit).toContain("include: ['test/unit/**/*.test.ts']");
    expect(architecture).toContain("include: ['test/architecture/**/*.test.ts']");
    expect(architecture).toContain('fileParallelism: false');
    expect(integration).toContain("include: ['test/integration/**/*.test.ts']");
    expect(e2e).toContain("include: ['test/e2e/**/*.test.ts']");
    expect(e2e).toContain("exclude: ['test/e2e/scenarios/live-*.test.ts']");
    expect(live).toContain("include: ['test/e2e/scenarios/live-*.test.ts']");
    expect(workflow).toContain('fast-verify:');
    expect(workflow).toContain('npm run verify && npm run knip');
    expect(workflow).toContain('integration:');
    expect(workflow).toContain('npm run test:integration');
    expect(workflow).toContain('e2e:');
    expect(workflow).toContain('npm run test:e2e');
    expect(workflow).toContain('web:');
    expect(workflow).toContain('npm run test:web');
    expect(workflow.match(/cache: npm/g) ?? []).toHaveLength(5);

    for (const command of [
      'start',
      'tick',
      'ui',
      'e2e:github-fake',
      'smoke',
      'smoke:claude',
      'smoke:codex',
      'smoke:cursor',
    ]) {
      expect(packageJson.scripts[command]).toContain('--tsconfig tsconfig.source.json');
    }
  });
});
