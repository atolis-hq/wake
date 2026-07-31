import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

type RuleName =
  | 'closed-vocabulary'
  | 'event-literals'
  | 'stream-literals'
  | 'entity-ref'
  | 'erased-events'
  | 'payload-coercion';
type ContractDiagnostic = { readonly message: string };

type CheckContractVocabulary = (
  root: string,
  options?: { readonly rules?: readonly RuleName[] },
) => Promise<readonly ContractDiagnostic[]>;

const checkerModulePath = '../../scripts/lib/contract-vocabulary.mjs';
const { checkContractVocabulary } = (await import(checkerModulePath)) as {
  readonly checkContractVocabulary: CheckContractVocabulary;
};

const fixtureRoots: string[] = [];
const unrelatedPayloadSource =
  'export function render(settings: { payload: { count: unknown } }) { const { payload } = settings; return Number(settings.payload.count) + String(payload.count); } export function destructured({ payload }: { payload: { count: unknown } }) { return Number(payload.count); }';

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

function messages(diagnostics: readonly { readonly message: string }[]): string {
  return diagnostics.map(({ message }) => message).join('\n');
}

function expectMessagesContain(
  diagnostics: readonly ContractDiagnostic[],
  expected: readonly string[],
): void {
  const output = messages(diagnostics);
  for (const value of expected) expect(output).toContain(value);
}

function providerEventFunction(name: string): string {
  return `export function ${name}() { return 'work.item-created'; }`;
}

function registeredCatalogues(): Readonly<Record<string, string>> {
  return {
    'src-next/work/contracts/events.ts':
      "export const WorkEventType = { Created: 'work.item-created' } as const;",
    'src-next/work/contracts/streams.ts':
      "export const WorkStreamKind = { Item: 'work-item' } as const;",
    'src-next/activities/contracts/review.ts': [
      "import { defineClosedVocabulary } from '../../kernel/index.js';",
      'export const ReviewDecision = defineClosedVocabulary({',
      "  Approved: 'review.approved',",
      '});',
    ].join('\n'),
  };
}

describe('contract vocabulary checker', () => {
  it('rejects a registered event literal outside its owning events contract', async () => {
    const root = await fixture({
      'src-next/work/contracts/events.ts': [
        'export const WorkEventType = {',
        "  Created: 'work.item-created',",
        '} as const;',
        "export const duplicate = 'work.item-created';",
      ].join('\n'),
      'src-next/work/domain/work-item.ts': [
        "export const repeated = 'work.item-created';",
        "export const text = 'Observed work.item-created successfully';",
      ].join('\n'),
    });

    const diagnostics = await checkContractVocabulary(root, { rules: ['event-literals'] });

    expect(messages(diagnostics)).toContain(
      'src-next/work/domain/work-item.ts:1:25 [event-literals] "work.item-created"',
    );
    expect(messages(diagnostics)).toContain(
      'src-next/work/contracts/events.ts:4:26 [event-literals] "work.item-created"',
    );
    expect(messages(diagnostics)).toContain('WorkEventType');
    expect(diagnostics).toHaveLength(2);
  });

  it('rejects a registered stream literal outside its owning streams contract', async () => {
    const root = await fixture({
      'src-next/work/contracts/streams.ts': [
        'export const WorkStreamKind = {',
        "  Item: 'work-item',",
        '} as const;',
        "export const duplicate = 'work-item';",
      ].join('\n'),
      'src-next/work/application/repository.ts': "export const kind = 'work-item';",
    });

    const diagnostics = await checkContractVocabulary(root, { rules: ['stream-literals'] });

    expect(messages(diagnostics)).toContain(
      'src-next/work/application/repository.ts:1:21 [stream-literals] "work-item"',
    );
    expect(messages(diagnostics)).toContain(
      'src-next/work/contracts/streams.ts:4:26 [stream-literals] "work-item"',
    );
    expect(messages(diagnostics)).toContain('WorkStreamKind');
    expect(diagnostics).toHaveLength(2);
  });

  it('filters optional rules and sorts diagnostics deterministically', async () => {
    const root = await fixture({
      'src-next/work/contracts/events.ts':
        "export const WorkEventType = { Created: 'work.item-created' } as const;",
      'src-next/work/contracts/streams.ts':
        "export const WorkStreamKind = { Item: 'work-item' } as const;",
      'src-next/work/domain/z-last.ts': "export const eventType = 'work.item-created';",
      'src-next/work/application/a-first.ts': [
        "export const eventType = 'work.item-created';",
        "export const streamKind = 'work-item';",
        "export const stream = entityRef('work-item', 'work-1');",
      ].join('\n'),
    });

    const diagnostics = await checkContractVocabulary(root, { rules: ['event-literals'] });

    expect(diagnostics.map(({ message }) => message.split(':', 1)[0])).toEqual([
      'src-next/work/application/a-first.ts',
      'src-next/work/domain/z-last.ts',
    ]);
    expect(messages(diagnostics)).not.toContain('[stream-literals]');
    expect(messages(diagnostics)).not.toContain('[entity-ref]');
  });
});

describe('contract structure checker', () => {
  it('rejects direct entityRef calls outside stream contracts', async () => {
    const root = await fixture({
      'src-next/kernel/contracts/identifiers.ts':
        'export const entityRef = (kind: string, id: string) => ({ kind, id });',
      'src-next/work/contracts/streams.ts': [
        "import { entityRef } from '../../kernel/contracts/identifiers.js';",
        "export const workStream = (id: string) => entityRef('work-item', id);",
      ].join('\n'),
      'src-next/work/application/repository.ts': [
        "import { entityRef as rawRef } from '../../kernel/contracts/identifiers.js';",
        'const helper = { entityRef: () => ({ kind: "local", id: "local" }) };',
        'export const local = helper.entityRef();',
        "export const stream = rawRef('work-item', 'work-1');",
        'export function shadow(rawRef: (kind: string, id: string) => unknown) {',
        "  return rawRef('local', 'local-1');",
        '}',
      ].join('\n'),
    });

    const diagnostics = await checkContractVocabulary(root, { rules: ['entity-ref'] });

    expect(messages(diagnostics)).toContain(
      'src-next/work/application/repository.ts:4:23 [entity-ref] "entityRef(...)"',
    );
    expect(messages(diagnostics)).toContain('work/contracts/streams.ts');
    expect(diagnostics).toHaveLength(1);
  });
});

describe('domain contract structure', () => {
  it('requires exact event, payload, and stream generics from imported event contracts', async () => {
    const root = await fixture({
      'src-next/work/contracts/streams.ts': [
        "import type { EntityRef } from '../../kernel/index.js';",
        'type Brand<Value, Name extends string> = Value & { readonly __brand: Name };',
        "type WorkItemId = Brand<string, 'WorkItemId'>;",
        "export type WorkItemStream = EntityRef<'work-item', WorkItemId>;",
      ].join('\n'),
      'src-next/work/domain/work-item.ts': [
        "import type { EntityRef, EventDraft as Draft, EventEnvelope } from '../../kernel/index.js';",
        "import type { WorkItemStream } from '../contracts/streams.js';",
        'type Payload = { readonly objective: string };',
        'type Brand<Value, Name extends string> = Value & { readonly __brand: Name };',
        "type WorkItemId = Brand<string, 'WorkItemId'>;",
        "type TypedStream = EntityRef<'work-item', WorkItemId>;",
        "export type MissingStream = Draft<'work.item-created', Payload>;",
        "export type BareStream = EventEnvelope<'work.item-created', Payload, EntityRef>;",
        "export type StringStream = EventEnvelope<'work.item-created', Payload, EntityRef<string, string>>;",
        "export type AnyStream = EventEnvelope<'work.item-created', Payload, EntityRef<any, unknown>>;",
        'export type Fact = Draft<any, any, any>;',
        "export type TypedFact = EventEnvelope<'work.item-created', Payload, TypedStream>;",
        "export type NamedFact = EventEnvelope<'work.item-created', Payload, WorkItemStream>;",
      ].join('\n'),
      'src-next/work/domain/local-type.ts': [
        "import type { EventEnvelope as Envelope } from '../../kernel/index.js';",
        'export function local<Envelope>(event: Envelope) {',
        '  return event;',
        '}',
      ].join('\n'),
    });

    const diagnostics = await checkContractVocabulary(root, { rules: ['erased-events'] });

    expectMessagesContain(diagnostics, [
      `"Draft<'work.item-created', Payload>" must be replaced by EventDraftUnion`,
      `"EventEnvelope<'work.item-created', Payload, EntityRef>" must be replaced by EventUnion`,
      `"EventEnvelope<'work.item-created', Payload, EntityRef<string, string>>" must be replaced by EventUnion`,
      `"EventEnvelope<'work.item-created', Payload, EntityRef<any, unknown>>" must be replaced by EventUnion`,
      '"Draft<any, any, any>" must be replaced by EventDraftUnion',
    ]);
    expect(messages(diagnostics)).not.toContain('"Envelope"');
    expect(diagnostics).toHaveLength(5);
  });

  it('tracks payload coercion only from imported event contracts', async () => {
    const root = await fixture({
      'src-next/work/domain/work-item.ts': [
        "import type { EntityRef, EventDraftUnion, EventEnvelope, EventUnion } from '../../kernel/index.js';",
        'type Payload = { readonly objective: string; readonly count: unknown };',
        "type Payloads = { readonly 'work.item-created': Payload };",
        'type WorkItemId = string & { readonly __brand: "WorkItemId" };',
        "type Stream = EntityRef<'work-item', WorkItemId>;",
        'type WorkEvent = EventUnion<Payloads, Stream>;',
        'type WorkDraft = EventDraftUnion<Payloads, Stream>;',
        'export function fold(event: WorkEvent) {',
        '  const payload = event.payload as Record<string, unknown>;',
        '  const { payload: destructured } = event;',
        '  const fact = event;',
        '  return (',
        '    String(event.payload.objective) +',
        '    Number(event.payload.count) +',
        '    Number(payload.count) +',
        '    String(destructured.objective) +',
        '    String(fact.payload.objective)',
        '  );',
        '}',
        'export function foldDraft(event: WorkDraft) {',
        '  return Number(event.payload.count);',
        '}',
        "export function foldDestructured({ payload }: EventEnvelope<'work.item-created', Payload, Stream>) {",
        '  return Number(payload.count);',
        '}',
      ].join('\n'),
      'src-next/work/domain/settings.ts': unrelatedPayloadSource,
      'src-next/work/domain/shadowed-coercion.ts': [
        "import type { EntityRef, EventEnvelope } from '../../kernel/index.js';",
        'type Id = string & { readonly __brand: "Id" };',
        "type Fact = EventEnvelope<'work.item-created', { objective: string }, EntityRef<'work-item', Id>>;",
        'export function render(',
        '  event: Fact,',
        '  String: (value: unknown) => unknown,',
        '  Number: (value: unknown) => unknown,',
        ') {',
        '  return String(event.payload.objective) + Number(event.payload.objective);',
        '}',
      ].join('\n'),
    });

    const diagnostics = await checkContractVocabulary(root, { rules: ['payload-coercion'] });

    expectMessagesContain(diagnostics, [
      'src-next/work/domain/work-item.ts:13:5 [payload-coercion] "String(payload.*)"',
      'src-next/work/domain/work-item.ts:14:5 [payload-coercion] "Number(payload.*)"',
      'src-next/work/domain/work-item.ts:15:5 [payload-coercion] "Number(payload.*)"',
      'src-next/work/domain/work-item.ts:16:5 [payload-coercion] "String(payload.*)"',
      'src-next/work/domain/work-item.ts:17:5 [payload-coercion] "String(payload.*)"',
      'src-next/work/domain/work-item.ts:21:10 [payload-coercion] "Number(payload.*)"',
      'src-next/work/domain/work-item.ts:24:10 [payload-coercion] "Number(payload.*)"',
    ]);
    expect(messages(diagnostics)).not.toContain('settings.ts');
    expect(messages(diagnostics)).not.toContain('shadowed-coercion.ts');
    expect(diagnostics).toHaveLength(7);
  });
});

describe('contract vocabulary boundaries', () => {
  it('rejects values registered through defineClosedVocabulary when repeated elsewhere', async () => {
    const root = await fixture({
      'src-next/activities/contracts/review.ts': [
        "import { defineClosedVocabulary as defineVocabulary } from '../../kernel/index.js';",
        'const ReviewDecisionValues = {',
        "  Approved: 'review.approved',",
        '} as const satisfies Readonly<Record<string, string>>;',
        'export const ReviewDecision = defineVocabulary(ReviewDecisionValues);',
        "const duplicateInOwner = 'review.approved';",
        'export function local(',
        '  defineVocabulary: <Value>(value: Value) => Value,',
        ') {',
        '  return defineVocabulary({ Ignored: "review.ignored" });',
        '}',
        "const ignoredDuplicate = 'review.ignored';",
        'const CycleA = CycleB;',
        'const CycleB = CycleA;',
        'export const CyclicDecision = defineVocabulary(CycleA);',
      ].join('\n'),
      'src-next/activities/application/review.ts': "export const decision = 'review.approved';",
    });

    const diagnostics = await checkContractVocabulary(root, { rules: ['closed-vocabulary'] });

    expect(messages(diagnostics)).toContain(
      'src-next/activities/application/review.ts:1:25 [closed-vocabulary] "review.approved"',
    );
    expect(messages(diagnostics)).toContain(
      'src-next/activities/contracts/review.ts:6:26 [closed-vocabulary] "review.approved"',
    );
    expect(messages(diagnostics)).toContain('ReviewDecision');
    expect(messages(diagnostics)).not.toContain('review.ignored');
    expect(diagnostics).toHaveLength(2);
  });
});

describe('contract vocabulary permissions', () => {
  it('permits provider values in explicit decoder files and functions', async () => {
    const root = await fixture({
      ...registeredCatalogues(),
      'src-next/integrations/github/infrastructure/payload-decoder.ts':
        "export const providerEvent = 'work.item-created'; export const providerDecision = 'review.approved';",
      'src-next/integrations/github/application/provider-boundary.ts':
        "export function decodeProviderReviewCommand(raw: string) { return raw === 'review.approved'; }",
      'src-next/integrations/github/application/review-command.ts':
        "export function decodeReviewCommand(raw: string) { return raw === 'work.item-created'; }",
      'src-next/integrations/github/application/review-command-translator.ts':
        "export const providerStream = 'work-item';",
      'src-next/test-support/provider.decoder-fixture.ts':
        "export const providerEvent = 'work.item-created'; export const providerDecision = 'review.approved';",
    });

    await expect(checkContractVocabulary(root)).resolves.toEqual([]);
  });

  it('permits private persistence keys', async () => {
    const root = await fixture({
      ...registeredCatalogues(),
      'src-next/persistence/filesystem/event-record.ts': [
        'export const privateKeys = {',
        "  'work.item-created': true,",
        "  'work-item': true,",
        "  'review.approved': true,",
        '};',
      ].join('\n'),
    });

    await expect(checkContractVocabulary(root)).resolves.toEqual([]);
  });

  it('permits free text containing a registered value', async () => {
    const root = await fixture({
      ...registeredCatalogues(),
      'src-next/work/domain/description.ts':
        "export const description = 'work.item-created was accepted';",
    });

    await expect(checkContractVocabulary(root)).resolves.toEqual([]);
  });

  it('permits serialized corrupt-input fixtures', async () => {
    const root = await fixture({
      ...registeredCatalogues(),
      'src-next/work/domain/event.corrupt-fixture.ts': [
        "export const eventType = 'work.item-created';",
        "export const streamKind = 'work-item';",
        "export const decision = 'review.approved';",
        "export const ref = entityRef('work-item', 'work-1');",
        'export type Fact = EventEnvelope<string, unknown>;',
        'export const id = String(payload.id);',
      ].join('\n'),
    });

    await expect(checkContractVocabulary(root)).resolves.toEqual([]);
  });
});

describe('provider boundary enforcement', () => {
  it('rejects provider literals outside explicit decoder files and functions', async () => {
    const root = await fixture({
      'src-next/work/contracts/events.ts':
        "export const WorkEventType = { Created: 'work.item-created' } as const;",
      'src-next/integrations/github/infrastructure/source.ts':
        "export const providerEvent = 'work.item-created';",
      'src-next/integrations/github/infrastructure/client.ts':
        "export const providerEvent = 'work.item-created';",
      'src-next/integrations/github/infrastructure/decoders/client.ts':
        "export const providerEvent = 'work.item-created';",
      'src-next/integrations/github/infrastructure/cache.ts':
        "export const providerEvent = 'work.item-created';",
      'src-next/integrations/github/infrastructure/helper.ts': providerEventFunction('notDecoder'),
      'src-next/integrations/github/infrastructure/parse-cache.ts':
        providerEventFunction('parseCacheKey'),
      'src-next/integrations/github/infrastructure/review-command.ts':
        providerEventFunction('decodeReviewCommand'),
      'src-next/integrations/github/contracts/review.ts':
        providerEventFunction('decodeReviewCommand'),
      'src-next/integrations/github/infrastructure/parse-provider.ts':
        providerEventFunction('parseProviderEvent'),
      'src-next/integrations/github/infrastructure/translate-cache.ts':
        providerEventFunction('translateCacheKey'),
      'src-next/integrations/github/infrastructure/translate-provider.ts':
        providerEventFunction('translateProviderStream'),
    });

    const diagnostics = await checkContractVocabulary(root, { rules: ['event-literals'] });

    expect(diagnostics.map(({ message }) => message.split(':', 1)[0])).toEqual([
      'src-next/integrations/github/contracts/review.ts',
      'src-next/integrations/github/infrastructure/cache.ts',
      'src-next/integrations/github/infrastructure/client.ts',
      'src-next/integrations/github/infrastructure/decoders/client.ts',
      'src-next/integrations/github/infrastructure/helper.ts',
      'src-next/integrations/github/infrastructure/parse-cache.ts',
      'src-next/integrations/github/infrastructure/parse-provider.ts',
      'src-next/integrations/github/infrastructure/source.ts',
      'src-next/integrations/github/infrastructure/translate-cache.ts',
      'src-next/integrations/github/infrastructure/translate-provider.ts',
    ]);
    expect(messages(diagnostics)).toContain('"work.item-created"');
    expect(messages(diagnostics)).toContain('WorkEventType');
  });
});
