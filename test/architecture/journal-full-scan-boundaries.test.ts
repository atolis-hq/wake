import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));
const eslint = new ESLint({ cwd: root });
const fullScanSource = [
  'export function scan(journal: { readAll(position: number): Promise<unknown> }) {',
  '  return journal.readAll(0);',
  '}',
].join('\n');

async function restrictedRules(filePath: string): Promise<readonly string[]> {
  const [result] = await eslint.lintText(fullScanSource, { filePath });
  return result!.messages
    .map(({ ruleId }) => ruleId)
    .filter((ruleId): ruleId is string => ruleId?.startsWith('no-restricted-') === true);
}

describe('journal full-scan boundaries', () => {
  it('rejects an unscoped readAll(0) full-history rescan in a resident-loop-facing module', async () => {
    await expect(
      restrictedRules('src/orchestration/application/full-scan-fixture.ts'),
    ).resolves.toEqual(['no-restricted-syntax']);
  }, 30_000);

  it('rejects an unscoped readAll(0) full-history rescan reappearing in delivery-outcome-reactor.ts', async () => {
    await expect(
      restrictedRules('src/integrations/delivery/application/delivery-outcome-reactor.ts'),
    ).resolves.toEqual(['no-restricted-syntax']);
  }, 30_000);

  it.each([
    // Composition/wiring and CLI command handlers: startup and one-off
    // command volume, not a resident tick.
    'src/bootstrap/full-scan-fixture.ts',
    'src/surfaces/cli/commands/full-scan-fixture.ts',
    // Fake/test adapter, not production polling.
    'src/integrations/fake/full-scan-fixture.ts',
    // Test files routinely assert against a full journal dump; not a
    // resident loop.
    'test/unit/persistence/full-scan-fixture.test.ts',
  ])('permits the exact %s boundary', async (filePath) => {
    await expect(restrictedRules(filePath)).resolves.toEqual([]);
  });

  // These formerly scanned the whole journal under an exemption; they now read
  // streams or fold incrementally, so the rule applies to them like any module.
  it.each([
    'src/activities/pr/application.ts',
    'src/integrations/github/application/comment-history-reader.ts',
  ])(
    'rejects an unscoped readAll(0) full-history rescan in %s',
    async (filePath) => {
      await expect(restrictedRules(filePath)).resolves.toEqual(['no-restricted-syntax']);
    },
    15000,
  );
});
