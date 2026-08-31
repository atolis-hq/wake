import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { assertTypeScriptFixtureCompiles } from './support/typescript-fixture.js';

interface Diagnostic {
  readonly message: string;
}

type CheckEventArchitecture = (root: string) => Promise<readonly Diagnostic[]>;

const checker = (await import('../../scripts/check-event-architecture.mjs')) as {
  readonly checkEventArchitecture: CheckEventArchitecture;
};
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(
  files: Readonly<Record<string, string>>,
  modules: Readonly<Record<string, readonly string[]>> = {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wake-event-publishing-ownership-'));
  roots.push(root);
  const sourceFiles = {
    'src/kernel/index.ts': [
      "export { createEventData } from './domain/event-envelope.js';",
      "export type { EventData, EventEnvelope } from './contracts/events.js';",
      "export type { EventJournal } from './contracts/event-journal.js';",
    ].join('\n'),
    'src/kernel/domain/event-envelope.ts': [
      "import type { EventData } from '../contracts/events.js';",
      "export function createEventData(input: Omit<EventData, 'schemaVersion'>): EventData {",
      '  return { ...input, schemaVersion: 1 };',
      '}',
    ].join('\n'),
    'src/kernel/contracts/events.ts': [
      'export interface EventData<Type extends string = string, Payload = unknown> {',
      '  readonly eventId: string;',
      '  readonly eventType: Type;',
      '  readonly schemaVersion: 1;',
      '  readonly occurredAt: string;',
      '  readonly correlationId: string;',
      '  readonly causationId: string;',
      '  readonly actor: { readonly kind: string; readonly id: string };',
      '  readonly source: { readonly kind: string; readonly id: string };',
      '  readonly payload: Payload;',
      '}',
      'export interface EventEnvelope {',
      '  readonly event: EventData;',
      '  readonly stream: { readonly kind: string; readonly id: string };',
      '  readonly recordedAt: string;',
      '  readonly sequence: number;',
      '  readonly globalPosition: number;',
      '}',
    ].join('\n'),
    'src/kernel/contracts/event-journal.ts': [
      "import type { EventData, EventEnvelope } from './events.js';",
      'export interface EventJournal {',
      '  appendToStream(stream: unknown, sequence: number, events: readonly EventData[]): Promise<readonly EventEnvelope[]>;',
      '}',
    ].join('\n'),
    'src/work/index.ts': [
      "export * from './contracts/events.js';",
      "export * from './contracts/event-factory.js';",
    ].join('\n'),
    'src/work/contracts/events.ts': [
      "import type { EventData } from '../../kernel/index.js';",
      "export const WorkEventType = { Created: 'work.created' } as const;",
      "export type WorkEventData = EventData & { readonly eventType: 'work.created'; readonly payload: { readonly id: string } };",
    ].join('\n'),
    'src/work/contracts/event-factory.ts': [
      "import { createEventData as makeKernelEventData } from '../../kernel/index.js';",
      "import type { WorkEventData } from './events.js';",
      "export const createWorkEventData = (input: Omit<WorkEventData, 'schemaVersion'>): WorkEventData =>",
      '  makeKernelEventData(input) as WorkEventData;',
    ].join('\n'),
    ...files,
  };
  const manifests = {
    kernel: [],
    bootstrap: [],
    eventing: [],
    persistence: [],
    work: ['work.'],
    ...modules,
  };
  await Promise.all([
    ...Object.entries(sourceFiles).map(async ([path, source]) => {
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, source, 'utf8');
    }),
    ...Object.entries(manifests).map(async ([name, events]) => {
      const target = join(root, 'src', name, 'module.json');
      await mkdir(dirname(target), { recursive: true });
      await writeFile(
        target,
        JSON.stringify({
          name,
          kind: 'bounded',
          dependencies: [],
          publicEntry: './index.ts',
          namespaces: { events, config: [], relations: [], streams: [] },
        }),
        'utf8',
      );
    }),
  ]);
  await assertTypeScriptFixtureCompiles(root);
  return root;
}

function messages(diagnostics: readonly Diagnostic[]): string {
  return diagnostics.map(({ message }) => message).join('\n');
}

function eventInput(eventType = 'work.created'): string {
  return [
    '{',
    "  eventId: 'event-1',",
    `  eventType: '${eventType}',`,
    "  occurredAt: '2026-08-31T12:00:00.000Z',",
    "  correlationId: 'correlation-1',",
    "  causationId: 'causation-1',",
    "  actor: { kind: 'system', id: 'test' },",
    "  source: { kind: 'internal', id: 'test' },",
    "  payload: { id: 'work-1' },",
    '}',
  ].join('\n');
}

function envelopeLiteral(): string {
  return [
    '{',
    `  event: { ...${eventInput()}, schemaVersion: 1 },`,
    "  stream: { kind: 'work', id: 'work-1' },",
    "  recordedAt: '2026-08-31T12:00:01.000Z',",
    '  sequence: 1,',
    '  globalPosition: 1,',
    '}',
  ].join('\n');
}

describe('event publishing ownership', () => {
  it('permits owner factories, Kernel type references, journal adapters, and the test envelope helper', async () => {
    const root = await fixture({
      'src/bootstrap/local-name.ts': [
        'const createEventData = (value: unknown) => value;',
        'export const event = createEventData({ sequence: 1 });',
      ].join('\n'),
      'src/eventing/type-reference.ts': [
        "import type { EventEnvelope } from '../kernel/index.js';",
        'export type ProcessorInput = EventEnvelope;',
        "export type ImportedProcessorInput = import('../kernel/index.js').EventEnvelope;",
      ].join('\n'),
      'src/persistence/filesystem/file-event-journal.ts': [
        "import type { EventEnvelope } from '../../kernel/index.js';",
        `export const envelope: EventEnvelope = ${envelopeLiteral()};`,
      ].join('\n'),
      'src/test/support/event-envelope.ts': [
        "import { createEventData, type EventEnvelope } from '../../kernel/index.js';",
        `export const envelope: EventEnvelope = { ...${envelopeLiteral()}, event: createEventData(${eventInput()}) };`,
      ].join('\n'),
      'src/test/unit/kernel/event-envelope.test.ts': [
        "import { createEventData } from '../../../kernel/index.js';",
        `export const event = createEventData(${eventInput()});`,
      ].join('\n'),
    });

    await expect(checker.checkEventArchitecture(root)).resolves.toEqual([]);
  });

  it('rejects aliased, namespace, reassigned, re-exported, and statically computed Kernel factory calls in Bootstrap', async () => {
    const root = await fixture({
      'src/work/contracts/kernel-alias.ts':
        "export { createEventData as reExportedEventData } from '../../kernel/index.js';",
      'src/bootstrap/illegal-factories.ts': [
        "import { createEventData as makeEvent } from '../kernel/index.js';",
        "import * as Kernel from '../kernel/index.js';",
        "import { reExportedEventData } from '../work/contracts/kernel-alias.js';",
        'const assigned = makeEvent;',
        "const property = 'createEventData';",
        `export const aliased = makeEvent(${eventInput()});`,
        `export const namespaced = Kernel.createEventData(${eventInput()});`,
        `export const reassigned = assigned(${eventInput()});`,
        `export const reExported = reExportedEventData(${eventInput()});`,
        `export const computed = Kernel[property](${eventInput()});`,
      ].join('\n'),
    });

    const diagnostics = await checker.checkEventArchitecture(root);
    expect(
      diagnostics.filter(({ message }) => message.includes('[event-data-factory-owner]')),
    ).toHaveLength(6);
  });

  it('requires every owner-factory event type to match its manifest namespace', async () => {
    const root = await fixture(
      {
        'src/work/contracts/wrong-event-factory.ts': [
          "import { createEventData, type EventData } from '../../kernel/index.js';",
          "type WrongInput = Omit<EventData<'resources.observed'>, 'schemaVersion'>;",
          'declare const wrong: WrongInput;',
          'export const invalid = createEventData(wrong);',
        ].join('\n'),
        'src/work/contracts/owned-event-factory.ts': [
          "import { createEventData, type EventData } from '../../kernel/index.js';",
          "type OwnedInput = Omit<EventData<'work.created' | 'work.closed'>, 'schemaVersion'>;",
          'declare const owned: OwnedInput;',
          'export const valid = createEventData(owned);',
        ].join('\n'),
        'src/integrations/github/contracts/github-event-factory.ts': [
          "import { createEventData, type EventData } from '../../../kernel/index.js';",
          "type IntegrationInput = Omit<EventData<'integration.github.observed'>, 'schemaVersion'>;",
          'declare const input: IntegrationInput;',
          'export const valid = createEventData(input);',
        ].join('\n'),
      },
      { integrations: ['integration.'], resources: ['resources.'] },
    );

    const diagnostics = await checker.checkEventArchitecture(root);
    expect(
      diagnostics.filter(({ message }) => message.includes('[event-data-factory-owner]')),
    ).toHaveLength(1);
    expect(messages(diagnostics)).toContain('work/contracts/wrong-event-factory.ts:4');
  });

  it('rejects every indirect runtime reference to the Kernel factory', async () => {
    const root = await fixture({
      'src/bootstrap/indirect-factory-references.ts': [
        "import { createEventData, type EventData } from '../kernel/index.js';",
        "type Input = Omit<EventData<'work.created'>, 'schemaVersion'>;",
        'declare const input: Input;',
        'createEventData.call(undefined, input);',
        'createEventData.apply(undefined, [input]);',
        'const bound = createEventData.bind(undefined);',
        'const inputs: Input[] = [input];',
        'inputs.map(createEventData);',
        'Reflect.apply(createEventData, undefined, [input]);',
        'const assigned = createEventData;',
        'export { createEventData as leaked };',
        'export const values = [bound(input), assigned(input)];',
      ].join('\n'),
    });

    const diagnostics = await checker.checkEventArchitecture(root);
    expect(
      diagnostics.filter(({ message }) => message.includes('[event-data-factory-owner]')),
    ).toHaveLength(7);
  });

  it('does not reject indirect references to an unrelated local same-name function', async () => {
    const root = await fixture({
      'src/bootstrap/local-indirect-references.ts': [
        'const createEventData = (value: unknown) => value;',
        'const input = { value: 1 };',
        'createEventData.call(undefined, input);',
        'createEventData.apply(undefined, [input]);',
        'const bound = createEventData.bind(undefined);',
        'const inputs = [input];',
        'inputs.map(createEventData);',
        'Reflect.apply(createEventData, undefined, [input]);',
        'const assigned = createEventData;',
        'export { createEventData as leaked };',
        'export const values = [bound(input), assigned(input)];',
      ].join('\n'),
    });

    await expect(checker.checkEventArchitecture(root)).resolves.toEqual([]);
  });

  it('reports protected assignment sources without blaming calls after local reassignment', async () => {
    const root = await fixture({
      'src/bootstrap/flow-aware-factory.ts': [
        "import { createEventData, type EventData } from '../kernel/index.js';",
        'const local: typeof createEventData = (input) => ({ ...input, schemaVersion: 1 });',
        'let first: typeof createEventData = createEventData;',
        "first({} as Omit<EventData<'work.created'>, 'schemaVersion'>);",
        'first = local;',
        "first({} as Omit<EventData<'work.created'>, 'schemaVersion'>);",
        'let second: typeof createEventData = local;',
        "second({} as Omit<EventData<'work.created'>, 'schemaVersion'>);",
        'second = createEventData;',
        "second({} as Omit<EventData<'work.created'>, 'schemaVersion'>);",
      ].join('\n'),
    });

    const diagnostics = await checker.checkEventArchitecture(root);
    expect(
      diagnostics
        .filter(({ message }) => message.includes('[event-data-factory-owner]'))
        .map(({ message }) => message.split(':').slice(0, 2).join(':')),
    ).toEqual(['bootstrap/flow-aware-factory.ts:3', 'bootstrap/flow-aware-factory.ts:9']);
  });

  it('rejects declaration and assignment destructuring aliases of the Kernel factory', async () => {
    const root = await fixture({
      'src/bootstrap/illegal-destructuring.ts': [
        "import { createEventData } from '../kernel/index.js';",
        "import * as Kernel from '../kernel/index.js';",
        'const [fromArray] = [createEventData];',
        'const { createEventData: fromObject } = Kernel;',
        'let fromArrayAssignment: typeof createEventData = (input) => ({ ...input, schemaVersion: 1 });',
        '[fromArrayAssignment] = [createEventData];',
        'let fromObjectAssignment: typeof createEventData = (input) => ({ ...input, schemaVersion: 1 });',
        '({ createEventData: fromObjectAssignment } = Kernel);',
        'const { nested: { factory: fromNested } } = { nested: { factory: createEventData } };',
        'const [[fromNestedArray]] = [[createEventData]];',
        "const property = 'createEventData';",
        'const { [property]: fromComputed } = Kernel;',
        `export const array = fromArray(${eventInput()});`,
        `export const object = fromObject(${eventInput()});`,
        `export const arrayAssignment = fromArrayAssignment(${eventInput()});`,
        `export const objectAssignment = fromObjectAssignment(${eventInput()});`,
        `export const nested = fromNested(${eventInput()});`,
        `export const nestedArray = fromNestedArray(${eventInput()});`,
        `export const computed = fromComputed(${eventInput()});`,
      ].join('\n'),
    });

    const diagnostics = await checker.checkEventArchitecture(root);
    expect(
      diagnostics.filter(({ message }) => message.includes('[event-data-factory-owner]')),
    ).toHaveLength(7);
  });

  it('rejects default and rest bindings that expose the Kernel factory', async () => {
    const root = await fixture({
      'src/bootstrap/illegal-default-rest.ts': [
        "import { createEventData } from '../kernel/index.js';",
        "import * as Kernel from '../kernel/index.js';",
        'const local: typeof createEventData = (input) => ({ ...input, schemaVersion: 1 });',
        'const [fromDefault = createEventData]: [(typeof createEventData)?] = [];',
        'const [...factories]: [typeof createEventData] = [createEventData];',
        'const partial: Partial<typeof Kernel> = {};',
        'const { createEventData: fromObjectDefault = Kernel.createEventData } = partial;',
        'const { ...kernel } = Kernel;',
        'let assignedFactories: Array<typeof createEventData> = [local];',
        '[...assignedFactories] = [createEventData];',
        'let assignedKernel: typeof Kernel = { createEventData: local };',
        '({ ...assignedKernel } = Kernel);',
        'declare const index: number;',
        'declare const property: string;',
        `export const defaulted = fromDefault(${eventInput()});`,
        `export const arrayRest = factories[0]!(${eventInput()});`,
        `export const objectDefault = fromObjectDefault(${eventInput()});`,
        `export const objectRest = kernel.createEventData(${eventInput()});`,
        `export const assignedArrayRest = assignedFactories[0]!(${eventInput()});`,
        `export const assignedObjectRest = assignedKernel.createEventData(${eventInput()});`,
        `export const dynamicArrayRest = factories[index]!(${eventInput()});`,
        `export const dynamicObjectRest = Kernel[property as keyof typeof Kernel](${eventInput()});`,
      ].join('\n'),
    });

    const diagnostics = await checker.checkEventArchitecture(root);
    expect(
      diagnostics.filter(({ message }) => message.includes('[event-data-factory-owner]')),
    ).toHaveLength(6);
  });

  it('does not reject same-name local symbols or dynamic computed properties', async () => {
    const root = await fixture({
      'src/bootstrap/foreign-symbols.ts': [
        "import * as Kernel from '../kernel/index.js';",
        'const createEventData = (value: unknown) => value;',
        'interface EventEnvelope { readonly sequence: number }',
        'interface EventJournal { append(value: unknown): void }',
        'declare const journal: EventJournal;',
        'declare const property: string;',
        'export const local = createEventData({ sequence: 1 });',
        'export const envelope: EventEnvelope = { sequence: 1 };',
        'journal.append(local);',
        `export const dynamic = Kernel[property as keyof typeof Kernel](${eventInput()});`,
      ].join('\n'),
    });

    await expect(checker.checkEventArchitecture(root)).resolves.toEqual([]);
  });

  it('does not reject destructuring aliases of unrelated local functions', async () => {
    const root = await fixture({
      'src/bootstrap/local-destructuring.ts': [
        'const createEventData = (value: unknown) => value;',
        'const [fromArray] = [createEventData];',
        'const { createEventData: fromObject } = { createEventData };',
        'let fromAssignment = (value: unknown) => value;',
        '({ createEventData: fromAssignment } = { createEventData });',
        'const { nested: { factory: fromNested } } = { nested: { factory: createEventData } };',
        "const property = 'createEventData';",
        'const { [property]: fromComputed } = { createEventData };',
        'export const values = [',
        '  fromArray({ sequence: 1 }),',
        '  fromObject({ sequence: 2 }),',
        '  fromAssignment({ sequence: 3 }),',
        '  fromNested({ sequence: 4 }),',
        '  fromComputed({ sequence: 5 }),',
        '];',
      ].join('\n'),
    });

    await expect(checker.checkEventArchitecture(root)).resolves.toEqual([]);
  });

  it('does not reject default and rest bindings of unrelated local functions', async () => {
    const root = await fixture({
      'src/bootstrap/local-default-rest.ts': [
        'const createEventData = (value: unknown) => value;',
        'const [fromDefault = createEventData]: [(typeof createEventData)?] = [];',
        'const [...factories]: [typeof createEventData] = [createEventData];',
        'const partial: { createEventData?: typeof createEventData } = {};',
        'const { createEventData: fromObjectDefault = createEventData } = partial;',
        'const source = { createEventData };',
        'const { ...local } = source;',
        'let assignedFactories = [(value: unknown) => value];',
        '[...assignedFactories] = [createEventData];',
        'let assignedLocal = { createEventData: (value: unknown) => value };',
        '({ ...assignedLocal } = source);',
        'export const values = [',
        '  fromDefault({ sequence: 1 }),',
        '  factories[0]!({ sequence: 2 }),',
        '  fromObjectDefault({ sequence: 3 }),',
        '  local.createEventData({ sequence: 4 }),',
        '  assignedFactories[0]!({ sequence: 5 }),',
        '  assignedLocal.createEventData({ sequence: 6 }),',
        '];',
      ].join('\n'),
    });

    await expect(checker.checkEventArchitecture(root)).resolves.toEqual([]);
  });

  it('rejects EventEnvelope construction outside journal adapters and the shared test helper', async () => {
    const root = await fixture({
      'src/bootstrap/illegal-envelope.ts': [
        "import type { EventEnvelope } from '../kernel/index.js';",
        `export const envelope: EventEnvelope = ${envelopeLiteral()};`,
      ].join('\n'),
    });

    const diagnostics = await checker.checkEventArchitecture(root);
    expect(messages(diagnostics)).toContain('[event-envelope-construction-owner]');
  });

  it('rejects structurally assignable envelope and bounded event literals assembled with spreads', async () => {
    const root = await fixture({
      'src/bootstrap/spread-construction.ts': [
        "import type { EventEnvelope } from '../kernel/index.js';",
        "import type { WorkEventData } from '../work/index.js';",
        'const event = {',
        "  eventId: 'event-1', eventType: 'kernel.test', schemaVersion: 1 as const,",
        "  occurredAt: '2026-08-31T12:00:00.000Z', correlationId: 'correlation-1', causationId: 'causation-1',",
        "  actor: { kind: 'system', id: 'test' }, source: { kind: 'internal', id: 'test' }, payload: {},",
        '};',
        'const metadata = {',
        "  stream: { kind: 'work', id: 'work-1' }, recordedAt: '2026-08-31T12:00:01.000Z',",
        '  sequence: 1, globalPosition: 1,',
        '};',
        'const envelopeCandidate = { event, ...metadata };',
        'export const envelope: EventEnvelope = envelopeCandidate;',
        'const eventHeader = {',
        "  eventId: 'event-2', occurredAt: '2026-08-31T12:00:00.000Z', correlationId: 'correlation-2', causationId: 'causation-2',",
        "  actor: { kind: 'system', id: 'test' }, source: { kind: 'internal', id: 'test' },",
        '};',
        "const eventCandidate = { ...eventHeader, eventType: 'work.created' as const, schemaVersion: 1 as const, payload: { id: 'work-1' } };",
        'export const workEvent: WorkEventData = eventCandidate;',
        'const coincidental = { ...metadata, event: { payload: null } };',
        'export { coincidental };',
      ].join('\n'),
    });

    const diagnostics = await checker.checkEventArchitecture(root);
    expect(
      diagnostics.filter(({ message }) => message.includes('[event-envelope-construction-owner]')),
    ).toHaveLength(1);
    expect(
      diagnostics.filter(({ message }) => message.includes('[bounded-event-data-construction]')),
    ).toHaveLength(1);
  });

  it('inspects runtime ownership in .mts source files', async () => {
    const root = await fixture({
      'src/bootstrap/illegal-factory.mts': [
        "import { createEventData, type EventData } from '../kernel/index.js';",
        "declare const input: Omit<EventData<'work.created'>, 'schemaVersion'>;",
        'export const event = createEventData(input);',
      ].join('\n'),
    });

    const diagnostics = await checker.checkEventArchitecture(root);
    expect(messages(diagnostics)).toContain(
      'bootstrap/illegal-factory.mts:3:22 [event-data-factory-owner]',
    );
  });

  it('rejects legacy EventJournal append and draft vocabulary without matching unrelated append methods', async () => {
    const root = await fixture({
      'src/kernel/contracts/event-journal.ts': [
        "import type { EventData, EventEnvelope } from './events.js';",
        'export interface EventJournal {',
        '  append(events: readonly EventDraft[]): Promise<readonly EventEnvelope[]>;',
        '  appendToStream(stream: unknown, sequence: number, events: readonly EventData[]): Promise<readonly EventEnvelope[]>;',
        '}',
        'export interface EventDraft { readonly eventType: string }',
      ].join('\n'),
      'src/bootstrap/legacy-journal.ts': [
        "import type { EventJournal, EventDraft as Draft } from '../kernel/index.js';",
        'declare const journal: EventJournal;',
        'declare const draft: Draft;',
        'journal.append([draft]);',
        'const unrelated = { append: (value: unknown) => value };',
        'unrelated.append(draft);',
      ].join('\n'),
      'src/kernel/index.ts': [
        "export { createEventData } from './domain/event-envelope.js';",
        "export type { EventData, EventEnvelope } from './contracts/events.js';",
        "export type { EventDraft, EventJournal } from './contracts/event-journal.js';",
      ].join('\n'),
    });

    const diagnostics = await checker.checkEventArchitecture(root);
    expect(
      diagnostics.filter(({ message }) => message.includes('[legacy-event-journal-append]')),
    ).toHaveLength(2);
    expect(messages(diagnostics)).toContain('[legacy-event-draft-symbol]');
  });

  it('reports only statically resolved EventJournal append calls', async () => {
    const root = await fixture({
      'src/kernel/contracts/event-journal.ts': [
        "import type { EventData, EventEnvelope } from './events.js';",
        'export interface EventJournal {',
        '  append(events: readonly EventData[]): Promise<readonly EventEnvelope[]>;',
        '  appendToStream(stream: unknown, sequence: number, events: readonly EventData[]): Promise<readonly EventEnvelope[]>;',
        '}',
      ].join('\n'),
      'src/bootstrap/legacy-append-calls.ts': [
        "import type { EventJournal } from '../kernel/index.js';",
        'declare const journal: EventJournal;',
        'journal.append([]);',
        "const property = 'append';",
        'journal[property]([]);',
        'const unrelated = { append: (value: unknown) => value };',
        'unrelated.append([]);',
        'const values = { append: (value: unknown) => value };',
        'values.append([]);',
        "const dynamic: string = 'append';",
        'const dynamicValues: Record<string, (value: unknown) => unknown> = values;',
        'dynamicValues[dynamic]?.([]);',
      ].join('\n'),
    });

    const diagnostics = await checker.checkEventArchitecture(root);
    const appendDiagnostics = diagnostics.filter(({ message }) =>
      message.includes('[legacy-event-journal-append]'),
    );
    expect(appendDiagnostics).toHaveLength(3);
    expect(appendDiagnostics.map(({ message }) => message.split(' ')[0])).toEqual([
      'bootstrap/legacy-append-calls.ts:3:1',
      'bootstrap/legacy-append-calls.ts:5:1',
      'kernel/contracts/event-journal.ts:3:3',
    ]);
  });

  it('rejects a property-style legacy append declaration on EventJournal', async () => {
    const root = await fixture({
      'src/kernel/contracts/event-journal.ts': [
        "import type { EventData, EventEnvelope } from './events.js';",
        'export interface EventJournal {',
        '  readonly append: (events: readonly EventData[]) => Promise<readonly EventEnvelope[]>;',
        '  appendToStream(stream: unknown, sequence: number, events: readonly EventData[]): Promise<readonly EventEnvelope[]>;',
        '}',
      ].join('\n'),
    });

    const diagnostics = await checker.checkEventArchitecture(root);
    const appendDiagnostics = diagnostics.filter(({ message }) =>
      message.includes('[legacy-event-journal-append]'),
    );
    expect(appendDiagnostics).toHaveLength(1);
    expect(appendDiagnostics[0]?.message).toContain(
      'kernel/contracts/event-journal.ts:3:3 [legacy-event-journal-append]',
    );
  });

  it('rejects bounded event contract imports in Persistence and Eventing but permits them in Bootstrap', async () => {
    const root = await fixture({
      'src/persistence/illegal-event-type.ts':
        "import type { WorkEventData as PersistedWorkEvent } from '../work/index.js'; export type Illegal = PersistedWorkEvent;",
      'src/eventing/illegal-event-type.ts':
        "import { WorkEventType as Type } from '../work/index.js'; export const illegal = Type.Created;",
      'src/bootstrap/allowed-event-type.ts':
        "import type { WorkEventData } from '../work/index.js'; export type Allowed = WorkEventData;",
    });

    const diagnostics = await checker.checkEventArchitecture(root);
    expect(
      diagnostics.filter(({ message }) => message.includes('[bounded-event-import-owner]')),
    ).toHaveLength(2);
  });

  it('rejects bounded import types and re-exports in Persistence and Eventing', async () => {
    const root = await fixture({
      'src/persistence/illegal-import-type.ts':
        "export type Illegal = import('../work/index.js').WorkEventData;",
      'src/eventing/illegal-import-type.ts':
        "export type Illegal = import('../work/index.js').WorkEventData;",
      'src/persistence/illegal-re-export.ts':
        "export type { WorkEventData } from '../work/index.js';",
      'src/eventing/illegal-re-export.ts': "export { WorkEventType } from '../work/index.js';",
    });

    const diagnostics = await checker.checkEventArchitecture(root);
    expect(
      diagnostics.filter(({ message }) => message.includes('[bounded-event-import-owner]')),
    ).toHaveLength(4);
  });

  it('rejects direct bounded EventData construction in Bootstrap, Persistence, and Eventing', async () => {
    const illegalEvent = `{ ...${eventInput()}, schemaVersion: 1 }`;
    const root = await fixture({
      'src/bootstrap/illegal-event.ts': [
        "import type { WorkEventData } from '../work/index.js';",
        `export const event: WorkEventData = ${illegalEvent};`,
      ].join('\n'),
      'src/persistence/illegal-event.ts': [
        "import type { WorkEventData } from '../work/index.js';",
        `export const event: WorkEventData = ${illegalEvent};`,
      ].join('\n'),
      'src/eventing/illegal-event.ts': [
        "import type { WorkEventData } from '../work/index.js';",
        `export const event: WorkEventData = ${illegalEvent};`,
      ].join('\n'),
    });

    const diagnostics = await checker.checkEventArchitecture(root);
    expect(
      diagnostics.filter(({ message }) => message.includes('[bounded-event-data-construction]')),
    ).toHaveLength(3);
  });

  it('does not treat a factory path as an owner without a manifest event namespace', async () => {
    const root = await fixture(
      {
        'src/reporting/contracts/event-factory.ts': [
          "import { createEventData } from '../../kernel/index.js';",
          `export const event = createEventData(${eventInput('reporting.created')});`,
        ].join('\n'),
      },
      { reporting: [] },
    );

    const diagnostics = await checker.checkEventArchitecture(root);
    expect(messages(diagnostics)).toContain('[event-data-factory-owner]');
  });
});
