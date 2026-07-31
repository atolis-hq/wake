import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

type RuleName = 'closed-vocabulary' | 'event-literals' | 'stream-literals';

interface ContractDiagnostic {
  readonly message: string;
}

type CheckContractVocabulary = (
  root: string,
  options?: { readonly rules?: readonly RuleName[] },
) => Promise<readonly ContractDiagnostic[]>;

const checkerModulePath = '../../scripts/lib/contract-vocabulary.mjs';
const checker = (await import(checkerModulePath)) as {
  readonly checkContractVocabulary: CheckContractVocabulary;
  readonly CONTRACT_VOCABULARY_RULES: readonly string[];
};
const { checkContractVocabulary, CONTRACT_VOCABULARY_RULES } = checker;
const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wake-contract-vocabulary-'));
  fixtureRoots.push(root);
  await Promise.all(
    Object.entries(files).map(async ([path, source]) => {
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, source, 'utf8');
    }),
  );
  return root;
}

function messages(diagnostics: readonly ContractDiagnostic[]): string {
  return diagnostics.map(({ message }) => message).join('\n');
}

const eventCatalogue = "export const WorkEventType = { Created: 'work.item-created' } as const;";
const streamCatalogue = "export const WorkStreamKind = { Item: 'work-item' } as const;";
const closedCatalogue = [
  "import { defineClosedVocabulary } from '../../kernel/index.js';",
  'export const ReviewDecision = defineClosedVocabulary({',
  "  Approved: 'review.approved',",
  '} as const);',
].join('\n');

describe('contract vocabulary discovery', () => {
  it('exposes only the three parser vocabulary rules', () => {
    expect(CONTRACT_VOCABULARY_RULES).toEqual([
      'closed-vocabulary',
      'event-literals',
      'stream-literals',
    ]);
  });

  it('rejects a registered event literal outside its declaring initializer', async () => {
    const root = await fixture({
      'src-next/work/contracts/events.ts': [
        eventCatalogue,
        "export const repeated = 'work.item-created';",
      ].join('\n'),
      'src-next/work/domain/work-item.ts': "export const repeated = 'work.item-created';",
    });

    const diagnostics = await checkContractVocabulary(root, { rules: ['event-literals'] });

    expect(messages(diagnostics)).toContain(
      'src-next/work/contracts/events.ts:2:25 [event-literals] "work.item-created" must be replaced by WorkEventType',
    );
    expect(messages(diagnostics)).toContain(
      'src-next/work/domain/work-item.ts:1:25 [event-literals] "work.item-created" must be replaced by WorkEventType',
    );
    expect(diagnostics).toHaveLength(2);
  });

  it('rejects a registered stream literal outside its declaring initializer', async () => {
    const root = await fixture({
      'src-next/work/contracts/streams.ts': streamCatalogue,
      'src-next/work/application/repository.ts': "export const kind = 'work-item';",
    });

    const diagnostics = await checkContractVocabulary(root, { rules: ['stream-literals'] });

    expect(messages(diagnostics)).toContain(
      'src-next/work/application/repository.ts:1:21 [stream-literals] "work-item" must be replaced by WorkStreamKind',
    );
    expect(diagnostics).toHaveLength(1);
  });

  it('rejects a repeated defineClosedVocabulary value', async () => {
    const root = await fixture({
      'src-next/activities/contracts/review.ts': [
        closedCatalogue,
        "export const repeated = 'review.approved';",
      ].join('\n'),
      'src-next/activities/application/review.ts': "export const decision = 'review.approved';",
    });

    const diagnostics = await checkContractVocabulary(root, {
      rules: ['closed-vocabulary'],
    });

    expect(messages(diagnostics)).toContain(
      'src-next/activities/contracts/review.ts:5:25 [closed-vocabulary] "review.approved" must be replaced by ReviewDecision',
    );
    expect(messages(diagnostics)).toContain(
      'src-next/activities/application/review.ts:1:25 [closed-vocabulary] "review.approved" must be replaced by ReviewDecision',
    );
    expect(diagnostics).toHaveLength(2);
  });

  it('defaults to all rules and filters an explicit subset', async () => {
    const root = await fixture({
      'src-next/work/contracts/events.ts': eventCatalogue,
      'src-next/work/contracts/streams.ts': streamCatalogue,
      'src-next/activities/contracts/review.ts': closedCatalogue,
      'src-next/work/domain/duplicates.ts': [
        "export const eventType = 'work.item-created';",
        "export const streamKind = 'work-item';",
        "export const decision = 'review.approved';",
      ].join('\n'),
    });

    const allDiagnostics = await checkContractVocabulary(root);
    const eventDiagnostics = await checkContractVocabulary(root, {
      rules: ['event-literals'],
    });

    expect(allDiagnostics).toHaveLength(3);
    expect(eventDiagnostics).toHaveLength(1);
    expect(messages(eventDiagnostics)).toContain('[event-literals]');
  });
});

describe('event and stream catalogue shapes', () => {
  it.each([
    {
      name: 'indirect export',
      path: 'src-next/work/contracts/events.ts',
      source: [
        "const WorkEventType = { Created: 'work.item-created' } as const;",
        'export { WorkEventType };',
      ].join('\n'),
      expected: 'WorkEventType must be declared directly with export const',
    },
    {
      name: 'identifier initializer',
      path: 'src-next/work/contracts/events.ts',
      source: [
        "const values = { Created: 'work.item-created' } as const;",
        'export const WorkEventType = values;',
      ].join('\n'),
      expected: 'WorkEventType must use an inline object initializer',
    },
    {
      name: 'spread property',
      path: 'src-next/work/contracts/events.ts',
      source: [
        "const values = { Created: 'work.item-created' } as const;",
        'export const WorkEventType = { ...values } as const;',
      ].join('\n'),
      expected: 'WorkEventType contains a spread property',
    },
    {
      name: 'computed property',
      path: 'src-next/work/contracts/streams.ts',
      source: "export const WorkStreamKind = { ['Item']: 'work-item' } as const;",
      expected: 'WorkStreamKind contains a computed property',
    },
    {
      name: 'shorthand property',
      path: 'src-next/work/contracts/streams.ts',
      source: [
        "const Item = 'work-item';",
        'export const WorkStreamKind = { Item } as const;',
      ].join('\n'),
      expected: 'WorkStreamKind contains a shorthand property',
    },
    {
      name: 'non-string value',
      path: 'src-next/work/contracts/streams.ts',
      source: 'export const WorkStreamKind = { Item: 1 } as const;',
      expected: 'WorkStreamKind.Item must have a string-literal value',
    },
  ])('rejects an unsupported $name', async ({ path, source, expected }) => {
    const root = await fixture({ [path]: source });

    const diagnostics = await checkContractVocabulary(root);

    expect(messages(diagnostics)).toContain(expected);
    expect(messages(diagnostics)).toMatch(
      /src-next\/work\/contracts\/(?:events|streams)\.ts:\d+:\d+/,
    );
    expect(diagnostics).toHaveLength(1);
  });

  it('ignores unrelated declarations in event and stream contract files', async () => {
    const root = await fixture({
      'src-next/work/contracts/events.ts': [
        'export interface WorkEvent { readonly eventType: string }',
        'export const OtherValue = { Created: "work.item-created" };',
      ].join('\n'),
      'src-next/work/contracts/streams.ts': 'export type WorkStream = { readonly kind: string };',
    });

    await expect(checkContractVocabulary(root)).resolves.toEqual([]);
  });
});

describe('closed catalogue shapes', () => {
  it.each([
    {
      name: 'non-exported declaration',
      source:
        "const ReviewDecision = defineClosedVocabulary({ Approved: 'review.approved' } as const);",
      expected: 'ReviewDecision must be declared directly with export const',
    },
    {
      name: 'indirect export',
      source: [
        "const ReviewDecision = defineClosedVocabulary({ Approved: 'review.approved' } as const);",
        'export { ReviewDecision };',
      ].join('\n'),
      expected: 'ReviewDecision must be declared directly with export const',
    },
    {
      name: 'identifier argument',
      source: [
        "const values = { Approved: 'review.approved' } as const;",
        'export const ReviewDecision = defineClosedVocabulary(values);',
      ].join('\n'),
      expected: 'ReviewDecision must pass an inline object literal as const',
    },
    {
      name: 'nested helper call',
      source:
        "export const ReviewDecision = identity(defineClosedVocabulary({ Approved: 'review.approved' } as const));",
      expected: 'ReviewDecision must use defineClosedVocabulary(...) as its direct initializer',
    },
    {
      name: 'spread argument',
      source: [
        "const values = [{ Approved: 'review.approved' } as const];",
        'export const ReviewDecision = defineClosedVocabulary(...values);',
      ].join('\n'),
      expected: 'ReviewDecision must pass exactly one inline object literal as const',
    },
    {
      name: 'object spread',
      source: [
        "const values = { Approved: 'review.approved' } as const;",
        'export const ReviewDecision = defineClosedVocabulary({ ...values } as const);',
      ].join('\n'),
      expected: 'ReviewDecision contains a spread property',
    },
    {
      name: 'computed property',
      source:
        "export const ReviewDecision = defineClosedVocabulary({ ['Approved']: 'review.approved' } as const);",
      expected: 'ReviewDecision contains a computed property',
    },
    {
      name: 'shorthand property',
      source: [
        "const Approved = 'review.approved';",
        'export const ReviewDecision = defineClosedVocabulary({ Approved } as const);',
      ].join('\n'),
      expected: 'ReviewDecision contains a shorthand property',
    },
    {
      name: 'non-string value',
      source: 'export const ReviewDecision = defineClosedVocabulary({ Approved: 1 } as const);',
      expected: 'ReviewDecision.Approved must have a string-literal value',
    },
    {
      name: 'argument without const assertion',
      source:
        "export const ReviewDecision = defineClosedVocabulary({ Approved: 'review.approved' });",
      expected: 'ReviewDecision inline object argument must use as const',
    },
  ])('rejects an unsupported $name', async ({ source, expected }) => {
    const root = await fixture({
      'src-next/activities/contracts/review.ts': source,
    });

    const diagnostics = await checkContractVocabulary(root);

    expect(messages(diagnostics)).toContain(expected);
    expect(messages(diagnostics)).toMatch(/src-next\/activities\/contracts\/review\.ts:\d+:\d+/);
    expect(diagnostics).toHaveLength(1);
  });
});

describe('exact vocabulary permissions', () => {
  it('checks no-substitution templates while retaining exact path permissions', async () => {
    const root = await fixture({
      'src-next/work/contracts/events.ts': eventCatalogue,
      'src-next/work/contracts/streams.ts': streamCatalogue,
      'src-next/activities/contracts/review.ts': closedCatalogue,
      'src-next/work/domain/templates.ts': [
        'export const eventType = `work.item-created`;',
        'export const streamKind = `work-item`;',
        'export const decision = `review.approved`;',
      ].join('\n'),
      'src-next/integrations/github/infrastructure/event-decoder.ts':
        'export const eventType = `work.item-created`;',
      'src-next/persistence/filesystem/event-record.ts': 'export const streamKind = `work-item`;',
      'src-next/work/domain/event.corrupt-fixture.ts': 'export const decision = `review.approved`;',
    });

    const diagnostics = await checkContractVocabulary(root);

    expect(messages(diagnostics)).toContain(
      'src-next/work/domain/templates.ts:1:26 [event-literals] "work.item-created" must be replaced by WorkEventType',
    );
    expect(messages(diagnostics)).toContain(
      'src-next/work/domain/templates.ts:2:27 [stream-literals] "work-item" must be replaced by WorkStreamKind',
    );
    expect(messages(diagnostics)).toContain(
      'src-next/work/domain/templates.ts:3:25 [closed-vocabulary] "review.approved" must be replaced by ReviewDecision',
    );
    expect(diagnostics).toHaveLength(3);
  });

  it('permits exact integration, persistence, corrupt-fixture, and free-text boundaries', async () => {
    const root = await fixture({
      'src-next/work/contracts/events.ts': eventCatalogue,
      'src-next/work/contracts/streams.ts': streamCatalogue,
      'src-next/activities/contracts/review.ts': closedCatalogue,
      'src-next/integrations/github/infrastructure/event-decoder.ts':
        "export const value = 'work.item-created';",
      'src-next/integrations/github/application/review-translator.ts':
        "export const value = 'review.approved';",
      'src-next/integrations/github/application/stream-translation.ts':
        "export const value = 'work-item';",
      'src-next/persistence/filesystem/event-record.ts':
        "export const value = 'work.item-created';",
      'src-next/work/domain/event.corrupt-fixture.ts': "export const value = 'review.approved';",
      'src-next/work/domain/description.ts':
        "export const text = 'work.item-created was accepted';",
    });

    await expect(checkContractVocabulary(root)).resolves.toEqual([]);
  });

  it('rejects near-miss boundary paths and function-name heuristics', async () => {
    const duplicate = "export const value = 'work.item-created';";
    const root = await fixture({
      'src-next/work/contracts/events.ts': eventCatalogue,
      'src-next/integrations/github/infrastructure/decoder.ts': duplicate,
      'src-next/integrations/github/infrastructure/decoders/event.ts': duplicate,
      'src-next/integrations/github/infrastructure/event-decoder.test.ts': duplicate,
      'src-next/integrations/github/application/review.ts':
        "export function decodeReview() { return 'work.item-created'; }",
      'src-next/work/infrastructure/event-decoder.ts': duplicate,
      'src-next/not-persistence/filesystem/event-record.ts': duplicate,
      'src-next/work/domain/Z-last.ts': duplicate,
      'src-next/work/domain/a-first.ts': duplicate,
      'src-next/work/domain/corrupt-fixtures/event.ts': duplicate,
      'src-next/work/domain/event.corrupt-fixture.test.ts': duplicate,
    });

    const diagnostics = await checkContractVocabulary(root, { rules: ['event-literals'] });

    expect(diagnostics.map(({ message }) => message.split(':', 1)[0])).toEqual([
      'src-next/integrations/github/application/review.ts',
      'src-next/integrations/github/infrastructure/decoder.ts',
      'src-next/integrations/github/infrastructure/decoders/event.ts',
      'src-next/integrations/github/infrastructure/event-decoder.test.ts',
      'src-next/not-persistence/filesystem/event-record.ts',
      'src-next/work/domain/Z-last.ts',
      'src-next/work/domain/a-first.ts',
      'src-next/work/domain/corrupt-fixtures/event.ts',
      'src-next/work/domain/event.corrupt-fixture.test.ts',
      'src-next/work/infrastructure/event-decoder.ts',
    ]);
  });
});
