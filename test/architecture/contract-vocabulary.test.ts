import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

type RuleName = 'closed-vocabulary' | 'event-literals' | 'stream-literals' | 'provider-locality';

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
    fixtureRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })),
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
  it('exposes the parser vocabulary rules and the provider-locality rule', () => {
    expect(CONTRACT_VOCABULARY_RULES).toEqual([
      'closed-vocabulary',
      'event-literals',
      'stream-literals',
      'provider-locality',
    ]);
  });

  it('rejects a registered event literal outside its declaring initializer', async () => {
    const root = await fixture({
      'src/work/contracts/events.ts': [
        eventCatalogue,
        "export const repeated = 'work.item-created';",
      ].join('\n'),
      'src/work/domain/work-item.ts': "export const repeated = 'work.item-created';",
    });

    const diagnostics = await checkContractVocabulary(root, { rules: ['event-literals'] });

    expect(messages(diagnostics)).toContain(
      'src/work/contracts/events.ts:2:25 [event-literals] "work.item-created" must be replaced by WorkEventType',
    );
    expect(messages(diagnostics)).toContain(
      'src/work/domain/work-item.ts:1:25 [event-literals] "work.item-created" must be replaced by WorkEventType',
    );
    expect(diagnostics).toHaveLength(2);
  });

  it('rejects a registered stream literal outside its declaring initializer', async () => {
    const root = await fixture({
      'src/work/contracts/streams.ts': streamCatalogue,
      'src/work/application/repository.ts': "export const kind = 'work-item';",
    });

    const diagnostics = await checkContractVocabulary(root, { rules: ['stream-literals'] });

    expect(messages(diagnostics)).toContain(
      'src/work/application/repository.ts:1:21 [stream-literals] "work-item" must be replaced by WorkStreamKind',
    );
    expect(diagnostics).toHaveLength(1);
  });
});

describe('contract vocabulary catalogue boundaries', () => {
  it('scopes health-status vocabularies to their owning module without weakening local literals', async () => {
    const root = await fixture({
      'src/eventing/contracts/vocabulary.ts': [
        "import { defineClosedVocabulary } from '../../kernel/index.js';",
        'export const ProcessorHealthStatus = defineClosedVocabulary({',
        "  Degraded: 'degraded',",
        '} as const);',
      ].join('\n'),
      'src/eventing/application/runtime.ts': "const status = 'degraded';",
      'src/integrations/application/runtime.ts': "const status = 'degraded';",
    });

    const diagnostics = await checkContractVocabulary(root, { rules: ['closed-vocabulary'] });

    expect(messages(diagnostics)).toBe(
      'src/eventing/application/runtime.ts:1:16 [closed-vocabulary] "degraded" must be replaced by ProcessorHealthStatus',
    );
  });

  it('rejects a closed-vocabulary collision hidden behind a name-like function', async () => {
    const root = await fixture({
      'src/kernel/contracts/vocabulary.ts': [
        "import { defineClosedVocabulary } from '../index.js';",
        'export const EventActorKind = defineClosedVocabulary({',
        "  Agent: 'agent',",
        '} as const);',
      ].join('\n'),
      'src/activities/contracts/vocabulary.ts': [
        'const fakeName = (value: string) => value;',
        "export const BuiltInActivityName = { Agent: fakeName('agent') } as const;",
      ].join('\n'),
    });

    const diagnostics = await checkContractVocabulary(root, { rules: ['closed-vocabulary'] });

    expect(messages(diagnostics)).toBe(
      'src/activities/contracts/vocabulary.ts:2:54 [closed-vocabulary] "agent" must be replaced by EventActorKind',
    );
  });

  it('permits a colliding literal inside another explicit catalogue only', async () => {
    const root = await fixture({
      'src/integrations/contracts/streams.ts':
        "export const IntegrationStreamKind = { Integration: 'integration' } as const;",
      'src/kernel/contracts/events.ts': [
        "import { defineClosedVocabulary } from './vocabulary.js';",
        'export const EventActorKind = defineClosedVocabulary({',
        "  System: 'system',",
        "  Integration: 'integration',",
        '} as const);',
      ].join('\n'),
      'src/integrations/github/infrastructure/source.ts': [
        'const actor = { kind: EventActorKind.Integration, id: "github" };',
        "const repeated = 'integration';",
      ].join('\n'),
    });

    const diagnostics = await checkContractVocabulary(root, { rules: ['stream-literals'] });

    expect(messages(diagnostics)).toBe(
      'src/integrations/github/infrastructure/source.ts:2:18 [stream-literals] "integration" must be replaced by IntegrationStreamKind',
    );
  });

  it('rejects a repeated defineClosedVocabulary value', async () => {
    const root = await fixture({
      'src/activities/contracts/review.ts': [
        closedCatalogue,
        "export const repeated = 'review.approved';",
      ].join('\n'),
      'src/activities/application/review.ts': "export const decision = 'review.approved';",
    });

    const diagnostics = await checkContractVocabulary(root, {
      rules: ['closed-vocabulary'],
    });

    expect(messages(diagnostics)).toContain(
      'src/activities/contracts/review.ts:5:25 [closed-vocabulary] "review.approved" must be replaced by ReviewDecision',
    );
    expect(messages(diagnostics)).toContain(
      'src/activities/application/review.ts:1:25 [closed-vocabulary] "review.approved" must be replaced by ReviewDecision',
    );
    expect(diagnostics).toHaveLength(2);
  });

  it('recognizes a parenthesized direct defineClosedVocabulary call', async () => {
    const root = await fixture({
      'src/activities/contracts/review.ts': [
        "import { defineClosedVocabulary } from '../../kernel/index.js';",
        'export const ReviewDecision = (defineClosedVocabulary)({',
        "  Approved: 'review.approved',",
        '} as const);',
      ].join('\n'),
      'src/activities/application/review.ts': "export const decision = 'review.approved';",
    });

    const diagnostics = await checkContractVocabulary(root, {
      rules: ['closed-vocabulary'],
    });

    expect(messages(diagnostics)).toContain(
      'src/activities/application/review.ts:1:25 [closed-vocabulary] "review.approved" must be replaced by ReviewDecision',
    );
    expect(diagnostics).toHaveLength(1);
  });

  it('defaults to all rules and filters an explicit subset', async () => {
    const root = await fixture({
      'src/work/contracts/events.ts': eventCatalogue,
      'src/work/contracts/streams.ts': streamCatalogue,
      'src/activities/contracts/review.ts': closedCatalogue,
      'src/work/domain/duplicates.ts': [
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

describe('validated catalogue literal exemptions', () => {
  it.each([
    {
      name: 'misleading exported catalogue name',
      path: 'src/work/domain/pseudo-catalogue.ts',
      source: "export const NotReallyAnEventType = () => 'work-item';",
    },
    {
      name: 'malformed event catalogue',
      path: 'src/activities/contracts/events.ts',
      source: "export const ActivityEventType = { Fake: 'work-item' };",
    },
    {
      name: 'malformed stream catalogue',
      path: 'src/activities/contracts/streams.ts',
      source: "export const ActivityStreamKind = { Fake: 'work-item' };",
    },
    {
      name: 'malformed closed catalogue',
      path: 'src/activities/contracts/review.ts',
      source: [
        "import { defineClosedVocabulary } from '../../kernel/index.js';",
        "export const ReviewDecision = defineClosedVocabulary({ Fake: 'work-item' });",
      ].join('\n'),
    },
  ])('does not exempt a $name', async ({ path, source }) => {
    const root = await fixture({
      'src/work/contracts/streams.ts': streamCatalogue,
      [path]: source,
    });

    const diagnostics = await checkContractVocabulary(root, { rules: ['stream-literals'] });

    expect(messages(diagnostics)).toContain(
      `[stream-literals] "work-item" must be replaced by WorkStreamKind`,
    );
    expect(diagnostics.some(({ message }) => message.startsWith(path))).toBe(true);
  });
});

describe('event and stream catalogue shapes', () => {
  it.each([
    {
      name: 'indirect export',
      path: 'src/work/contracts/events.ts',
      source: [
        "const WorkEventType = { Created: 'work.item-created' } as const;",
        'export { WorkEventType };',
      ].join('\n'),
      expected: 'WorkEventType must be declared directly with export const',
    },
    {
      name: 'identifier initializer',
      path: 'src/work/contracts/events.ts',
      source: [
        "const values = { Created: 'work.item-created' } as const;",
        'export const WorkEventType = values;',
      ].join('\n'),
      expected: 'WorkEventType must use an inline object initializer',
    },
    {
      name: 'event catalogue without const assertion',
      path: 'src/work/contracts/events.ts',
      source: "export const WorkEventType = { Created: 'work.item-created' };",
      expected: 'WorkEventType inline object initializer must use as const',
    },
    {
      name: 'stream catalogue without const assertion',
      path: 'src/work/contracts/streams.ts',
      source: "export const WorkStreamKind = { Item: 'work-item' };",
      expected: 'WorkStreamKind inline object initializer must use as const',
    },
    {
      name: 'spread property',
      path: 'src/work/contracts/events.ts',
      source: [
        "const values = { Created: 'work.item-created' } as const;",
        'export const WorkEventType = { ...values } as const;',
      ].join('\n'),
      expected: 'WorkEventType contains a spread property',
    },
    {
      name: 'computed property',
      path: 'src/work/contracts/streams.ts',
      source: "export const WorkStreamKind = { ['Item']: 'work-item' } as const;",
      expected: 'WorkStreamKind contains a computed property',
    },
    {
      name: 'shorthand property',
      path: 'src/work/contracts/streams.ts',
      source: [
        "const Item = 'work-item';",
        'export const WorkStreamKind = { Item } as const;',
      ].join('\n'),
      expected: 'WorkStreamKind contains a shorthand property',
    },
    {
      name: 'non-string value',
      path: 'src/work/contracts/streams.ts',
      source: 'export const WorkStreamKind = { Item: 1 } as const;',
      expected: 'WorkStreamKind.Item must have a string-literal value',
    },
    {
      name: 'event namespace export',
      path: 'src/work/contracts/events.ts',
      source: "export * as WorkEventType from './event-values.js';",
      expected: 'WorkEventType must be declared directly with export const',
    },
    {
      name: 'stream namespace export',
      path: 'src/work/contracts/streams.ts',
      source: "export * as WorkStreamKind from './stream-values.js';",
      expected: 'WorkStreamKind must be declared directly with export const',
    },
  ])('rejects an unsupported $name', async ({ path, source, expected }) => {
    const root = await fixture({ [path]: source });

    const diagnostics = await checkContractVocabulary(root);

    expect(messages(diagnostics)).toContain(expected);
    expect(messages(diagnostics)).toMatch(/src\/work\/contracts\/(?:events|streams)\.ts:\d+:\d+/);
    expect(diagnostics).toHaveLength(1);
  });

  it('ignores unrelated declarations in event and stream contract files', async () => {
    const root = await fixture({
      'src/work/contracts/events.ts': [
        'export interface WorkEvent { readonly eventType: string }',
        'export const OtherValue = { Created: "work.item-created" };',
      ].join('\n'),
      'src/work/contracts/streams.ts': 'export type WorkStream = { readonly kind: string };',
    });

    await expect(checkContractVocabulary(root)).resolves.toEqual([]);
  });
});

describe('exact vocabulary permissions', () => {
  it('checks no-substitution templates while retaining exact path permissions', async () => {
    const root = await fixture({
      'src/work/contracts/events.ts': eventCatalogue,
      'src/work/contracts/streams.ts': streamCatalogue,
      'src/activities/contracts/review.ts': closedCatalogue,
      'src/work/domain/templates.ts': [
        'export const eventType = `work.item-created`;',
        'export const streamKind = `work-item`;',
        'export const decision = `review.approved`;',
      ].join('\n'),
      'src/integrations/github/infrastructure/event-decoder.ts':
        'export const eventType = `work.item-created`;',
      'src/persistence/filesystem/event-record.ts': 'export const streamKind = `work-item`;',
      'src/work/domain/event.corrupt-fixture.ts': 'export const decision = `review.approved`;',
    });

    const diagnostics = await checkContractVocabulary(root);

    expect(messages(diagnostics)).toContain(
      'src/work/domain/templates.ts:1:26 [event-literals] "work.item-created" must be replaced by WorkEventType',
    );
    expect(messages(diagnostics)).toContain(
      'src/work/domain/templates.ts:2:27 [stream-literals] "work-item" must be replaced by WorkStreamKind',
    );
    expect(messages(diagnostics)).toContain(
      'src/work/domain/templates.ts:3:25 [closed-vocabulary] "review.approved" must be replaced by ReviewDecision',
    );
    expect(diagnostics).toHaveLength(3);
  });

  it('permits exact integration, persistence, corrupt-fixture, and free-text boundaries', async () => {
    const root = await fixture({
      'src/work/contracts/events.ts': eventCatalogue,
      'src/work/contracts/streams.ts': streamCatalogue,
      'src/activities/contracts/review.ts': closedCatalogue,
      'src/integrations/github/infrastructure/event-decoder.ts':
        "export const value = 'work.item-created';",
      'src/integrations/github/application/review-translator.ts':
        "export const value = 'review.approved';",
      'src/integrations/github/application/stream-translation.ts':
        "export const value = 'work-item';",
      'src/persistence/filesystem/event-record.ts': "export const value = 'work.item-created';",
      'src/work/domain/event.corrupt-fixture.ts': "export const value = 'review.approved';",
      'src/work/domain/description.ts': "export const text = 'work.item-created was accepted';",
    });

    await expect(checkContractVocabulary(root)).resolves.toEqual([]);
  });

  it('rejects near-miss boundary paths and function-name heuristics', async () => {
    const duplicate = "export const value = 'work.item-created';";
    const root = await fixture({
      'src/work/contracts/events.ts': eventCatalogue,
      'src/integrations/github/infrastructure/decoder.ts': duplicate,
      'src/integrations/github/infrastructure/decoders/event.ts': duplicate,
      'src/integrations/github/infrastructure/event-decoder.test.ts': duplicate,
      'src/integrations/github/application/review.ts':
        "export function decodeReview() { return 'work.item-created'; }",
      'src/work/infrastructure/event-decoder.ts': duplicate,
      'src/not-persistence/filesystem/event-record.ts': duplicate,
      'src/work/domain/Z-last.ts': duplicate,
      'src/work/domain/a-first.ts': duplicate,
      'src/work/domain/corrupt-fixtures/event.ts': duplicate,
      'src/work/domain/event.corrupt-fixture.test.ts': duplicate,
    });

    const diagnostics = await checkContractVocabulary(root, { rules: ['event-literals'] });

    expect(diagnostics.map(({ message }) => message.split(':', 1)[0])).toEqual([
      'src/integrations/github/application/review.ts',
      'src/integrations/github/infrastructure/decoder.ts',
      'src/integrations/github/infrastructure/decoders/event.ts',
      'src/integrations/github/infrastructure/event-decoder.test.ts',
      'src/not-persistence/filesystem/event-record.ts',
      'src/work/domain/Z-last.ts',
      'src/work/domain/a-first.ts',
      'src/work/domain/corrupt-fixtures/event.ts',
      'src/work/domain/event.corrupt-fixture.test.ts',
      'src/work/infrastructure/event-decoder.ts',
    ]);
  });
});
