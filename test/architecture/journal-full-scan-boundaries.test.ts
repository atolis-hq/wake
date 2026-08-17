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
  }, 15000);

  it.each([
    // Owns the journal and already gates full rescans behind a
    // last-seen-position check.
    'src/persistence/application/full-scan-fixture.ts',
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

  // These three are exact-file exemptions (their directory siblings stay
  // covered), so the boundary can only be exercised against the real path —
  // real-path type-checked linting is slower than a fixture path.
  it.each([
    // Bounded by actual pr.merge command volume, not a resident tick.
    'src/activities/pr/application.ts',
    // Bounded by actual agent-activation volume, not a resident tick.
    'src/integrations/github/application/comment-history-reader.ts',
    // Deliberately re-evaluates every past delivery event against current
    // orchestration state on every tick; see the file's own comment.
    'src/integrations/delivery/application/delivery-outcome-reactor.ts',
  ])(
    'permits the exact %s boundary',
    async (filePath) => {
      await expect(restrictedRules(filePath)).resolves.toEqual([]);
    },
    15000,
  );
});
