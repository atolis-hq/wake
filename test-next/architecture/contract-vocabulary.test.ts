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

interface ContractDiagnostic {
  readonly message: string;
}

type CheckContractVocabulary = (
  root: string,
  options?: { readonly rules?: readonly RuleName[] },
) => Promise<readonly ContractDiagnostic[]>;

const checkerModulePath = '../../scripts/lib/contract-vocabulary.mjs';
const { checkContractVocabulary } = (await import(checkerModulePath)) as {
  readonly checkContractVocabulary: CheckContractVocabulary;
};

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

function messages(diagnostics: readonly { readonly message: string }[]): string {
  return diagnostics.map(({ message }) => message).join('\n');
}

describe('contract vocabulary checker', () => {
  it('rejects a registered event literal outside its owning events contract', async () => {
    const root = await fixture({
      'src-next/work/contracts/events.ts': [
        'export const WorkEventType = {',
        "  Created: 'work.item-created',",
        '} as const;',
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
    expect(messages(diagnostics)).toContain('WorkEventType');
    expect(diagnostics).toHaveLength(1);
  });

  it('rejects a registered stream literal outside its owning streams contract', async () => {
    const root = await fixture({
      'src-next/work/contracts/streams.ts': [
        'export const WorkStreamKind = {',
        "  Item: 'work-item',",
        '} as const;',
      ].join('\n'),
      'src-next/work/application/repository.ts': "export const kind = 'work-item';",
    });

    const diagnostics = await checkContractVocabulary(root, { rules: ['stream-literals'] });

    expect(messages(diagnostics)).toContain(
      'src-next/work/application/repository.ts:1:21 [stream-literals] "work-item"',
    );
    expect(messages(diagnostics)).toContain('WorkStreamKind');
    expect(diagnostics).toHaveLength(1);
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
      ].join('\n'),
    });

    const diagnostics = await checkContractVocabulary(root, { rules: ['entity-ref'] });

    expect(messages(diagnostics)).toContain(
      'src-next/work/application/repository.ts:4:23 [entity-ref] "entityRef(...)"',
    );
    expect(messages(diagnostics)).toContain('work/contracts/streams.ts');
    expect(diagnostics).toHaveLength(1);
  });

  it('rejects erased domain events and persisted-payload coercion', async () => {
    const root = await fixture({
      'src-next/work/domain/work-item.ts': [
        "import type { EventDraft as Draft, EventEnvelope } from '../../kernel/index.js';",
        'export type Fact = Draft<any, any>;',
        "export function fold(event: EventEnvelope<'work.item-created', any>) {",
        '  const payload = event.payload as Record<string, unknown>;',
        '  return String(event.payload.objective) + Number(payload.count);',
        '}',
      ].join('\n'),
      'src-next/work/domain/local-type.ts': [
        'type EventEnvelope<Type, Payload> = readonly [Type, Payload];',
        'export type LocalFact = EventEnvelope<any, any>;',
      ].join('\n'),
    });

    const diagnostics = await checkContractVocabulary(root, {
      rules: ['erased-events', 'payload-coercion'],
    });

    expect(messages(diagnostics)).toContain(
      'src-next/work/domain/work-item.ts:2:20 [erased-events] "Draft<any, any>"',
    );
    expect(messages(diagnostics)).toContain('EventDraftUnion');
    expect(messages(diagnostics)).toContain(
      `src-next/work/domain/work-item.ts:3:29 [erased-events] "EventEnvelope<'work.item-created', any>"`,
    );
    expect(messages(diagnostics)).toContain('EventUnion');
    expect(messages(diagnostics)).toContain(
      'src-next/work/domain/work-item.ts:5:10 [payload-coercion] "String(payload.*)"',
    );
    expect(messages(diagnostics)).toContain(
      'src-next/work/domain/work-item.ts:5:44 [payload-coercion] "Number(payload.*)"',
    );
    expect(messages(diagnostics)).toContain('typed payload');
    expect(diagnostics).toHaveLength(4);
  });
});

describe('contract vocabulary boundaries', () => {
  it('rejects values registered through defineClosedVocabulary when repeated elsewhere', async () => {
    const root = await fixture({
      'src-next/activities/contracts/review.ts': [
        "import { defineClosedVocabulary as defineVocabulary } from '../../kernel/index.js';",
        'export const ReviewDecision = defineVocabulary({',
        "  Approved: 'review.approved',",
        '});',
        "const duplicateInOwner = 'review.approved';",
      ].join('\n'),
      'src-next/activities/application/review.ts': "export const decision = 'review.approved';",
    });

    const diagnostics = await checkContractVocabulary(root, { rules: ['closed-vocabulary'] });

    expect(messages(diagnostics)).toContain(
      'src-next/activities/application/review.ts:1:25 [closed-vocabulary] "review.approved"',
    );
    expect(messages(diagnostics)).toContain(
      'src-next/activities/contracts/review.ts:5:26 [closed-vocabulary] "review.approved"',
    );
    expect(messages(diagnostics)).toContain('ReviewDecision');
    expect(diagnostics).toHaveLength(2);
  });

  it('permits provider decoding, persistence keys, free text, and corrupt-input fixtures', async () => {
    const root = await fixture({
      'src-next/work/contracts/events.ts': [
        'export const WorkEventType = {',
        "  Created: 'work.item-created',",
        '} as const;',
      ].join('\n'),
      'src-next/work/contracts/streams.ts': [
        'export const WorkStreamKind = {',
        "  Item: 'work-item',",
        '} as const;',
      ].join('\n'),
      'src-next/activities/contracts/review.ts': [
        'export const ReviewDecision = defineClosedVocabulary({',
        "  Approved: 'review.approved',",
        '});',
      ].join('\n'),
      'src-next/integrations/github/infrastructure/payload-decoder.ts': [
        "export const providerEvent = 'work.item-created';",
        "export const providerDecision = 'review.approved';",
      ].join('\n'),
      'src-next/integrations/github/application/review-command.ts': [
        'export function decodeReviewCommand(raw: string) {',
        "  return raw === 'review.approved';",
        '}',
      ].join('\n'),
      'src-next/test-support/provider.decoder-fixture.ts': [
        "export const providerEvent = 'work.item-created';",
        "export const providerDecision = 'review.approved';",
      ].join('\n'),
      'src-next/persistence/filesystem/event-record.ts': [
        'export const privateKeys = {',
        "  'work.item-created': true,",
        "  'work-item': true,",
        "  'review.approved': true,",
        '};',
      ].join('\n'),
      'src-next/work/domain/description.ts':
        "export const description = 'work.item-created was accepted';",
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

  it('rejects provider literals outside explicit decoder files and functions', async () => {
    const root = await fixture({
      'src-next/work/contracts/events.ts':
        "export const WorkEventType = { Created: 'work.item-created' } as const;",
      'src-next/integrations/github/infrastructure/source.ts':
        "export const providerEvent = 'work.item-created';",
      'src-next/integrations/github/infrastructure/client.ts':
        "export const providerEvent = 'work.item-created';",
      'src-next/integrations/github/infrastructure/cache.ts':
        "export const providerEvent = 'work.item-created';",
    });

    const diagnostics = await checkContractVocabulary(root, { rules: ['event-literals'] });

    expect(diagnostics.map(({ message }) => message.split(':', 1)[0])).toEqual([
      'src-next/integrations/github/infrastructure/cache.ts',
      'src-next/integrations/github/infrastructure/client.ts',
      'src-next/integrations/github/infrastructure/source.ts',
    ]);
    expect(messages(diagnostics)).toContain('"work.item-created"');
    expect(messages(diagnostics)).toContain('WorkEventType');
  });
});
