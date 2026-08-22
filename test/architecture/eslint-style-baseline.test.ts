import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));
const eslint = new ESLint({ cwd: root });
const fixturePath = 'src/work/domain/style-fixture.ts';

async function ruleIds(source: string, prefix: string): Promise<readonly string[]> {
  const [result] = await eslint.lintText(source, { filePath: fixturePath });
  return result!.messages
    .map(({ ruleId }) => ruleId)
    .filter((ruleId): ruleId is string => ruleId?.startsWith(prefix) === true);
}

describe('style baseline', () => {
  it('requires a blank line between multi-line class members', { timeout: 30_000 }, async () => {
    const source = [
      'export class Probe {',
      '  first(): number {',
      '    return 1;',
      '  }',
      '  second(): number {',
      '    return 2;',
      '  }',
      '}',
    ].join('\n');

    await expect(ruleIds(source, '@stylistic/')).resolves.toEqual([
      '@stylistic/lines-between-class-members',
    ]);
  });

  it('requires a blank line before a function declaration', async () => {
    const source = [
      'const seed = 1;',
      'export function probe(): number {',
      '  return seed;',
      '}',
    ].join('\n');

    await expect(ruleIds(source, '@stylistic/')).resolves.toEqual([
      '@stylistic/padding-line-between-statements',
    ]);
  });

  it('requires a type-only import to be declared with import type', async () => {
    const source = [
      "import { WorkItemView } from '../contracts/views.js';",
      'export type Alias = WorkItemView;',
    ].join('\n');

    await expect(ruleIds(source, '@typescript-eslint/consistent-type-imports')).resolves.toEqual([
      '@typescript-eslint/consistent-type-imports',
    ]);
  });
});
