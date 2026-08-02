import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));
const eslint = new ESLint({ cwd: root });
const restrictedSource = [
  "import { type EventDraft as DraftAlias, type EventEnvelope as EnvelopeAlias, entityRef as refAlias } from '../../kernel/index.js';",
  'void (undefined as unknown as DraftAlias);',
  'void (undefined as unknown as EnvelopeAlias);',
  "void refAlias('kind', 'id');",
  'export const values = (value: unknown) => [String(value), Number(value)];',
].join('\n');

async function restrictedRules(filePath: string): Promise<readonly string[]> {
  const [result] = await eslint.lintText(restrictedSource, { filePath });
  return result!.messages
    .map(({ ruleId }) => ruleId)
    .filter((ruleId): ruleId is string => ruleId?.startsWith('no-restricted-') === true);
}

describe('typed domain and application contract boundaries', () => {
  it('rejects aliased generic event and entity imports plus identifier coercion calls', async () => {
    await expect(restrictedRules('src-next/work/domain/restricted-fixture.ts')).resolves.toEqual([
      'no-restricted-imports',
      'no-restricted-imports',
      'no-restricted-imports',
      'no-restricted-syntax',
      'no-restricted-syntax',
    ]);
  });

  it.each([
    'src-next/work/contracts/allowed-fixture.ts',
    'src-next/integrations/github/application/allowed-fixture.ts',
    'src-next/persistence/application/allowed-fixture.ts',
    'test-next/unit/work/allowed-fixture.test.ts',
  ])('permits the exact %s boundary', async (filePath) => {
    await expect(restrictedRules(filePath)).resolves.toEqual([]);
  });
});
