import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

interface ContractDiagnostic {
  readonly message: string;
}

const checkerModulePath = '../../scripts/lib/contract-vocabulary.mjs';
const { checkContractVocabulary } = (await import(checkerModulePath)) as {
  readonly checkContractVocabulary: (root: string) => Promise<readonly ContractDiagnostic[]>;
};
const fixtureRoots: string[] = [];
const directExportError = 'ReviewDecision must be declared directly with export const';
const directSpellingError =
  'ReviewDecision must call defineClosedVocabulary with its direct identifier spelling';
const renamedVocabularyImport =
  "import { defineClosedVocabulary as defineVocabulary } from '../../kernel/index.js';";
const namespaceVocabularyImport = "import * as vocabulary from '../../kernel/index.js';";

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(source: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wake-contract-vocabulary-closed-'));
  fixtureRoots.push(root);
  const target = join(root, 'src-next/activities/contracts/review.ts');
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, source, 'utf8');
  return root;
}

function sourceLines(...lines: readonly string[]): string {
  return lines.join('\n');
}

const closedShapeCases = [
  [
    'non-exported declaration',
    "const ReviewDecision = defineClosedVocabulary({ Approved: 'review.approved' } as const);",
    directExportError,
  ],
  [
    'indirect export',
    sourceLines(
      "const ReviewDecision = defineClosedVocabulary({ Approved: 'review.approved' } as const);",
      'export { ReviewDecision };',
    ),
    directExportError,
  ],
  [
    'identifier argument',
    sourceLines(
      "const values = { Approved: 'review.approved' } as const;",
      'export const ReviewDecision = defineClosedVocabulary(values);',
    ),
    'ReviewDecision must pass an inline object literal as const',
  ],
  [
    'renamed helper import',
    sourceLines(
      renamedVocabularyImport,
      "export const ReviewDecision = defineVocabulary({ Approved: 'review.approved' } as const);",
    ),
    directSpellingError,
  ],
  [
    'parenthesized renamed helper import',
    sourceLines(
      renamedVocabularyImport,
      "export const ReviewDecision = (defineVocabulary)({ Approved: 'review.approved' } as const);",
    ),
    directSpellingError,
  ],
  [
    'namespace helper member call',
    sourceLines(
      namespaceVocabularyImport,
      "export const ReviewDecision = vocabulary.defineClosedVocabulary({ Approved: 'review.approved' } as const);",
    ),
    directSpellingError,
  ],
  [
    'parenthesized namespace helper receiver',
    sourceLines(
      namespaceVocabularyImport,
      "export const ReviewDecision = (vocabulary).defineClosedVocabulary({ Approved: 'review.approved' } as const);",
    ),
    directSpellingError,
  ],
  [
    'template-key namespace helper member call',
    sourceLines(
      namespaceVocabularyImport,
      "export const ReviewDecision = vocabulary[`defineClosedVocabulary`]({ Approved: 'review.approved' } as const);",
    ),
    directSpellingError,
  ],
  [
    'nested helper call',
    "export const ReviewDecision = identity(defineClosedVocabulary({ Approved: 'review.approved' } as const));",
    'ReviewDecision must use defineClosedVocabulary(...) as its direct initializer',
  ],
  [
    'spread argument',
    sourceLines(
      "const values = [{ Approved: 'review.approved' } as const];",
      'export const ReviewDecision = defineClosedVocabulary(...values);',
    ),
    'ReviewDecision must pass exactly one inline object literal as const',
  ],
  [
    'object spread',
    sourceLines(
      "const values = { Approved: 'review.approved' } as const;",
      'export const ReviewDecision = defineClosedVocabulary({ ...values } as const);',
    ),
    'ReviewDecision contains a spread property',
  ],
  [
    'computed property',
    "export const ReviewDecision = defineClosedVocabulary({ ['Approved']: 'review.approved' } as const);",
    'ReviewDecision contains a computed property',
  ],
  [
    'shorthand property',
    sourceLines(
      "const Approved = 'review.approved';",
      'export const ReviewDecision = defineClosedVocabulary({ Approved } as const);',
    ),
    'ReviewDecision contains a shorthand property',
  ],
  [
    'non-string value',
    'export const ReviewDecision = defineClosedVocabulary({ Approved: 1 } as const);',
    'ReviewDecision.Approved must have a string-literal value',
  ],
  [
    'argument without const assertion',
    "export const ReviewDecision = defineClosedVocabulary({ Approved: 'review.approved' });",
    'ReviewDecision inline object argument must use as const',
  ],
] as const;

describe('closed catalogue shapes', () => {
  it.each(closedShapeCases)('rejects an unsupported %s', async (_name, source, expected) => {
    const root = await fixture(source);

    const diagnostics = await checkContractVocabulary(root);
    const messages = diagnostics.map(({ message }) => message).join('\n');

    expect(messages).toContain(expected);
    expect(messages).toMatch(/src-next\/activities\/contracts\/review\.ts:\d+:\d+/);
    expect(diagnostics).toHaveLength(1);
  });
});
