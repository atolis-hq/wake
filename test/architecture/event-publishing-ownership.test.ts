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
    'packages/eventing/src/index.ts': [
      "export { createEventData } from './contracts/event-envelope.js';",
      "export { decodeEventEnvelope } from './contracts/event-schema.js';",
      "export type { EventData, EventEnvelope } from './contracts/events.js';",
      "export type { EventJournal } from './store/event-journal.js';",
    ].join('\n'),
    'packages/eventing/src/contracts/event-envelope.ts': [
      "import type { EventData } from './events.js';",
      "export function createEventData(input: Omit<EventData, 'schemaVersion'>): EventData {",
      '  return { ...input, schemaVersion: 1 };',
      '}',
    ].join('\n'),
    'packages/eventing/src/contracts/events.ts': [
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
    'packages/eventing/src/store/event-journal.ts': [
      "import type { EventData, EventEnvelope } from '../contracts/events.js';",
      'export interface EventJournal {',
      '  appendToStream(stream: unknown, sequence: number, events: readonly EventData[]): Promise<readonly EventEnvelope[]>;',
      '}',
    ].join('\n'),
    'packages/eventing/src/contracts/event-schema.ts': [
      "import type { EventEnvelope } from './events.js';",
      'export function decodeEventEnvelope(input: unknown): EventEnvelope {',
      '  return input as EventEnvelope;',
      '}',
    ].join('\n'),
    'src/work/index.ts': [
      "export * from './contracts/events.js';",
      "export * from './contracts/event-factory.js';",
    ].join('\n'),
    'src/work/contracts/events.ts': [
      "import type { EventData } from '@atolis-hq/eventing';",
      "export const WorkEventType = { Created: 'work.created' } as const;",
      "export type WorkEventData = EventData & { readonly eventType: 'work.created'; readonly payload: { readonly id: string } };",
    ].join('\n'),
    'src/work/contracts/event-factory.ts': [
      "import { createEventData as makeEventData } from '@atolis-hq/eventing';",
      "import type { WorkEventData } from './events.js';",
      "export const createWorkEventData = (input: Omit<WorkEventData, 'schemaVersion'>): WorkEventData =>",
      '  makeEventData(input) as WorkEventData;',
    ].join('\n'),
    ...files,
  };
  const manifests = {
    kernel: [],
    bootstrap: [],
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

function envelopeLiteral(eventType = 'work.created'): string {
  return [
    '{',
    `  event: { ...${eventInput(eventType)}, schemaVersion: 1 },`,
    "  stream: { kind: 'work', id: 'work-1' },",
    "  recordedAt: '2026-08-31T12:00:01.000Z',",
    '  sequence: 1,',
    '  globalPosition: 1,',
    '}',
  ].join('\n');
}

describe('event publishing ownership', () => {
  it('permits owner factories, Eventing type references, journal adapters, and the test envelope helper', async () => {
    const root = await fixture({
      'src/bootstrap/local-name.ts': [
        'const createEventData = (value: unknown) => value;',
        'export const event = createEventData({ sequence: 1 });',
      ].join('\n'),
      'src/control-plane/type-reference.ts': [
        "import type { EventEnvelope } from '@atolis-hq/eventing';",
        'export type ProcessorInput = EventEnvelope;',
        "export type ImportedProcessorInput = import('@atolis-hq/eventing').EventEnvelope;",
      ].join('\n'),
      'src/persistence/filesystem/file-event-journal.ts': [
        "import type { EventEnvelope } from '@atolis-hq/eventing';",
        `export const envelope: EventEnvelope = ${envelopeLiteral()};`,
      ].join('\n'),
      'src/test/support/event-envelope.ts': [
        "import { createEventData, type EventEnvelope } from '@atolis-hq/eventing';",
        `export const envelope: EventEnvelope = { ...${envelopeLiteral()}, event: createEventData(${eventInput()}) };`,
      ].join('\n'),
      'src/test/unit/eventing/event-envelope.test.ts': [
        "import { createEventData } from '@atolis-hq/eventing';",
        `export const event = createEventData(${eventInput()});`,
      ].join('\n'),
    });

    await expect(checker.checkEventArchitecture(root)).resolves.toEqual([]);
  });

  it('rejects aliased, namespace, reassigned, re-exported, and statically computed Eventing factory calls in Bootstrap', async () => {
    const root = await fixture({
      'src/work/contracts/eventing-alias.ts':
        "export { createEventData as reExportedEventData } from '@atolis-hq/eventing';",
      'src/bootstrap/illegal-factories.ts': [
        "import { createEventData as makeEvent } from '@atolis-hq/eventing';",
        "import * as Eventing from '@atolis-hq/eventing';",
        "import { reExportedEventData } from '../work/contracts/eventing-alias.js';",
        'const assigned = makeEvent;',
        "const property = 'createEventData';",
        `export const aliased = makeEvent(${eventInput()});`,
        `export const namespaced = Eventing.createEventData(${eventInput()});`,
        `export const reassigned = assigned(${eventInput()});`,
        `export const reExported = reExportedEventData(${eventInput()});`,
        `export const computed = Eventing[property](${eventInput()});`,
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
          "import { createEventData, type EventData } from '@atolis-hq/eventing';",
          "type WrongInput = Omit<EventData<'resources.observed'>, 'schemaVersion'>;",
          'declare const wrong: WrongInput;',
          'export const invalid = createEventData(wrong);',
        ].join('\n'),
        'src/work/contracts/owned-event-factory.ts': [
          "import { createEventData, type EventData } from '@atolis-hq/eventing';",
          "type OwnedInput = Omit<EventData<'work.created' | 'work.closed'>, 'schemaVersion'>;",
          'declare const owned: OwnedInput;',
          'export const valid = createEventData(owned);',
        ].join('\n'),
        'src/integrations/github/contracts/github-event-factory.ts': [
          "import { createEventData, type EventData } from '@atolis-hq/eventing';",
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

  it('rejects every indirect runtime reference to the Eventing factory', async () => {
    const root = await fixture({
      'src/bootstrap/indirect-factory-references.ts': [
        "import { createEventData, type EventData } from '@atolis-hq/eventing';",
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
        "import { createEventData, type EventData } from '@atolis-hq/eventing';",
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

  it('rejects declaration and assignment destructuring aliases of the Eventing factory', async () => {
    const root = await fixture({
      'src/bootstrap/illegal-destructuring.ts': [
        "import { createEventData } from '@atolis-hq/eventing';",
        "import * as Eventing from '@atolis-hq/eventing';",
        'const [fromArray] = [createEventData];',
        'const { createEventData: fromObject } = Eventing;',
        'let fromArrayAssignment: typeof createEventData = (input) => ({ ...input, schemaVersion: 1 });',
        '[fromArrayAssignment] = [createEventData];',
        'let fromObjectAssignment: typeof createEventData = (input) => ({ ...input, schemaVersion: 1 });',
        '({ createEventData: fromObjectAssignment } = Eventing);',
        'const { nested: { factory: fromNested } } = { nested: { factory: createEventData } };',
        'const [[fromNestedArray]] = [[createEventData]];',
        "const property = 'createEventData';",
        'const { [property]: fromComputed } = Eventing;',
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

  it('rejects default and rest bindings that expose the Eventing factory', async () => {
    const root = await fixture({
      'src/bootstrap/illegal-default-rest.ts': [
        "import { createEventData } from '@atolis-hq/eventing';",
        "import * as Eventing from '@atolis-hq/eventing';",
        'const local: typeof createEventData = (input) => ({ ...input, schemaVersion: 1 });',
        'const [fromDefault = createEventData]: [(typeof createEventData)?] = [];',
        'const [...factories]: [typeof createEventData] = [createEventData];',
        'const partial: Partial<typeof Eventing> = {};',
        'const { createEventData: fromObjectDefault = Eventing.createEventData } = partial;',
        'const { ...eventing } = Eventing;',
        'let assignedFactories: Array<typeof createEventData> = [local];',
        '[...assignedFactories] = [createEventData];',
        'let assignedEventing: typeof Eventing = { createEventData: local, decodeEventEnvelope: (input) => input as never };',
        '({ ...assignedEventing } = Eventing);',
        'declare const index: number;',
        'declare const property: string;',
        `export const defaulted = fromDefault(${eventInput()});`,
        `export const arrayRest = factories[0]!(${eventInput()});`,
        `export const objectDefault = fromObjectDefault(${eventInput()});`,
        `export const objectRest = eventing.createEventData(${eventInput()});`,
        `export const assignedArrayRest = assignedFactories[0]!(${eventInput()});`,
        `export const assignedObjectRest = assignedEventing.createEventData(${eventInput()});`,
        `export const dynamicArrayRest = factories[index]!(${eventInput()});`,
        `export const dynamicObjectRest = Eventing[property as keyof typeof Eventing](${eventInput()});`,
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
        "import * as Eventing from '@atolis-hq/eventing';",
        'const createEventData = (value: unknown) => value;',
        'interface EventEnvelope { readonly sequence: number }',
        'interface EventJournal { append(value: unknown): void }',
        'declare const journal: EventJournal;',
        'declare const property: string;',
        'export const local = createEventData({ sequence: 1 });',
        'export const envelope: EventEnvelope = { sequence: 1 };',
        'journal.append(local);',
        `export const dynamic = Eventing[property as keyof typeof Eventing](${eventInput()});`,
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
        "import type { EventEnvelope } from '@atolis-hq/eventing';",
        `export const envelope: EventEnvelope = ${envelopeLiteral()};`,
      ].join('\n'),
    });

    const diagnostics = await checker.checkEventArchitecture(root);
    expect(messages(diagnostics)).toContain('[event-envelope-construction-owner]');
  });

  it('allows only the exact Eventing envelope decoder implementation to reshape envelopes', async () => {
    const root = await fixture({
      'src/control-plane/illegal-envelope.ts': [
        "import type { EventEnvelope } from '@atolis-hq/eventing';",
        `export const envelope: EventEnvelope = ${envelopeLiteral('kernel.test')};`,
      ].join('\n'),
      'src/bootstrap/decoder-wrapped-envelope.ts': [
        "import { decodeEventEnvelope } from '@atolis-hq/eventing';",
        `export const envelope = decodeEventEnvelope(${envelopeLiteral('kernel.test')});`,
      ].join('\n'),
      'packages/eventing/src/contracts/event-schema.ts': [
        "import type { EventEnvelope } from './events.js';",
        'export function decodeEventEnvelope(input: EventEnvelope): EventEnvelope {',
        '  const parsed = input;',
        '  return {',
        '    event: parsed.event,',
        '    stream: parsed.stream,',
        '    recordedAt: parsed.recordedAt,',
        '    sequence: parsed.sequence,',
        '    globalPosition: parsed.globalPosition,',
        '  };',
        '}',
      ].join('\n'),
    });

    const diagnostics = await checker.checkEventArchitecture(root);
    expect(
      diagnostics
        .filter(({ message }) => message.includes('[event-envelope-construction-owner]'))
        .map(({ message }) => message.split(' ')[0]),
    ).toEqual([
      'bootstrap/decoder-wrapped-envelope.ts:2:45',
      'control-plane/illegal-envelope.ts:2:40',
    ]);
  });

  it('does not reject complete but type-incompatible event and envelope lookalikes', async () => {
    const root = await fixture({
      'src/bootstrap/incompatible-lookalikes.ts': [
        'const event = {',
        '  eventId: 1,',
        "  eventType: 'work.created' as const,",
        "  schemaVersion: '1',",
        '  occurredAt: () => undefined,',
        '  correlationId: false,',
        "  causationId: Symbol('causation'),",
        "  actor: 'system',",
        '  source: [],',
        '  payload: () => undefined,',
        '};',
        'export const envelope = {',
        '  event,',
        '  stream: 42,',
        '  recordedAt: () => undefined,',
        "  sequence: '1',",
        '  globalPosition: false,',
        '};',
      ].join('\n'),
    });

    await expect(checker.checkEventArchitecture(root)).resolves.toEqual([]);
  });

  it('rejects structurally assignable envelope and bounded event literals assembled with spreads', async () => {
    const root = await fixture({
      'src/bootstrap/spread-construction.ts': [
        "import type { EventEnvelope } from '@atolis-hq/eventing';",
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

  it('rejects symbol-resolved Object.assign and typed builder construction forms', async () => {
    const root = await fixture({
      'src/bootstrap/non-literal-construction.ts': [
        "import type { EventEnvelope } from '@atolis-hq/eventing';",
        "import type { WorkEventData } from '../work/index.js';",
        'const eventHeader = {',
        "  eventId: 'event-1', occurredAt: '2026-08-31T12:00:00.000Z', correlationId: 'correlation-1', causationId: 'causation-1',",
        "  actor: { kind: 'system', id: 'test' }, source: { kind: 'internal', id: 'test' },",
        '};',
        "const kernelTail = { eventType: 'kernel.test' as const, schemaVersion: 1 as const, payload: {} };",
        'const kernelEvent = Object.assign({}, eventHeader, kernelTail);',
        'const envelopeMetadata = {',
        "  stream: { kind: 'work', id: 'work-1' }, recordedAt: '2026-08-31T12:00:01.000Z', sequence: 1, globalPosition: 1,",
        '};',
        'const assign = Object.assign;',
        "const assignKey = 'assign' as const;",
        'export const aliasedEnvelope: EventEnvelope = assign({}, { event: kernelEvent }, envelopeMetadata);',
        'export const computedEnvelope: EventEnvelope = Object[assignKey]({}, { event: kernelEvent }, envelopeMetadata);',
        "const workTail = { eventType: 'work.created' as const, schemaVersion: 1 as const, payload: { id: 'work-1' } };",
        'export const directWorkEvent: WorkEventData = Object.assign({}, eventHeader, workTail);',
        'const Objects = Object;',
        'export function buildWorkEvent(): WorkEventData {',
        '  return Objects.assign({}, eventHeader, workTail);',
        '}',
        'class EnvelopeBuilder implements EventEnvelope {',
        '  constructor(',
        "    readonly event: EventEnvelope['event'],",
        "    readonly stream: EventEnvelope['stream'],",
        '    readonly recordedAt: string,',
        '    readonly sequence: number,',
        '    readonly globalPosition: number,',
        '  ) {}',
        '}',
        'export function buildEnvelope(): EventEnvelope {',
        '  return new EnvelopeBuilder(kernelEvent, envelopeMetadata.stream, envelopeMetadata.recordedAt, 1, 1);',
        '}',
      ].join('\n'),
    });

    const diagnostics = await checker.checkEventArchitecture(root);
    expect(
      diagnostics.filter(({ message }) => message.includes('[event-envelope-construction-owner]')),
    ).toHaveLength(3);
    expect(
      diagnostics.filter(({ message }) => message.includes('[bounded-event-data-construction]')),
    ).toHaveLength(2);
  });

  it('allows decoder and journal-read flows while ignoring local or incompatible assign functions', async () => {
    const root = await fixture({
      'packages/eventing/src/contracts/event-schema.ts': [
        "import type { EventEnvelope } from './events.js';",
        'export function decodeEventEnvelope(input: unknown): EventEnvelope {',
        '  const parsed = input as EventEnvelope;',
        '  return Object.assign({}, parsed);',
        '}',
      ].join('\n'),
      'packages/eventing/src/store/event-journal.ts': [
        "import type { EventData, EventEnvelope } from '../contracts/events.js';",
        'export interface EventJournal {',
        '  appendToStream(stream: unknown, sequence: number, events: readonly EventData[]): Promise<readonly EventEnvelope[]>;',
        '  readAll(): Promise<readonly EventEnvelope[]>;',
        '}',
      ].join('\n'),
      'src/bootstrap/read-envelope.ts': [
        "import type { EventEnvelope, EventJournal } from '@atolis-hq/eventing';",
        'declare const journal: EventJournal;',
        'export async function readEnvelope(): Promise<EventEnvelope> {',
        '  return (await journal.readAll())[0]!;',
        '}',
      ].join('\n'),
      'src/bootstrap/local-assign-lookalikes.ts': [
        'const LocalObject = { assign: <Value>(value: Value): Value => value };',
        'export const incomplete = LocalObject.assign({ event: { payload: null }, sequence: 1 });',
        'export const incompatible = LocalObject.assign({',
        "  event: { eventId: 1, eventType: 'work.created', schemaVersion: '1', occurredAt: false, correlationId: 2, causationId: 3, actor: 'system', source: [], payload: () => undefined },",
        "  stream: 4, recordedAt: false, sequence: '1', globalPosition: null,",
        '});',
      ].join('\n'),
    });

    await expect(checker.checkEventArchitecture(root)).resolves.toEqual([]);
  });

  it('inspects runtime ownership in .mts source files', async () => {
    const root = await fixture({
      'src/bootstrap/illegal-factory.mts': [
        "import { createEventData, type EventData } from '@atolis-hq/eventing';",
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
      'packages/eventing/src/store/event-journal.ts': [
        "import type { EventData, EventEnvelope } from '../contracts/events.js';",
        'export interface EventJournal {',
        '  append(events: readonly EventDraft[]): Promise<readonly EventEnvelope[]>;',
        '  appendToStream(stream: unknown, sequence: number, events: readonly EventData[]): Promise<readonly EventEnvelope[]>;',
        '}',
        'export interface EventDraft { readonly eventType: string }',
      ].join('\n'),
      'src/bootstrap/legacy-journal.ts': [
        "import type { EventJournal, EventDraft as Draft } from '@atolis-hq/eventing';",
        'declare const journal: EventJournal;',
        'declare const draft: Draft;',
        'journal.append([draft]);',
        'const unrelated = { append: (value: unknown) => value };',
        'unrelated.append(draft);',
      ].join('\n'),
      'packages/eventing/src/index.ts': [
        "export { createEventData } from './contracts/event-envelope.js';",
        "export type { EventData, EventEnvelope } from './contracts/events.js';",
        "export type { EventDraft, EventJournal } from './store/event-journal.js';",
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
      'packages/eventing/src/store/event-journal.ts': [
        "import type { EventData, EventEnvelope } from '../contracts/events.js';",
        'export interface EventJournal {',
        '  append(events: readonly EventData[]): Promise<readonly EventEnvelope[]>;',
        '  appendToStream(stream: unknown, sequence: number, events: readonly EventData[]): Promise<readonly EventEnvelope[]>;',
        '}',
      ].join('\n'),
      'src/bootstrap/legacy-append-calls.ts': [
        "import type { EventJournal } from '@atolis-hq/eventing';",
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
      '../packages/eventing/src/store/event-journal.ts:3:3',
    ]);
  });

  it('rejects a property-style legacy append declaration on EventJournal', async () => {
    const root = await fixture({
      'packages/eventing/src/store/event-journal.ts': [
        "import type { EventData, EventEnvelope } from '../contracts/events.js';",
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
      '../packages/eventing/src/store/event-journal.ts:3:3 [legacy-event-journal-append]',
    );
  });

  it('rejects bounded event contract imports in Persistence but permits them in Bootstrap', async () => {
    const root = await fixture({
      'src/persistence/illegal-event-type.ts':
        "import type { WorkEventData as PersistedWorkEvent } from '../work/index.js'; export type Illegal = PersistedWorkEvent;",
      'src/bootstrap/allowed-event-type.ts':
        "import type { WorkEventData } from '../work/index.js'; export type Allowed = WorkEventData;",
    });

    const diagnostics = await checker.checkEventArchitecture(root);
    expect(
      diagnostics.filter(({ message }) => message.includes('[bounded-event-import-owner]')),
    ).toHaveLength(1);
  });

  it('rejects bounded import types and re-exports in Persistence', async () => {
    const root = await fixture({
      'src/persistence/illegal-import-type.ts':
        "export type Illegal = import('../work/index.js').WorkEventData;",
      'src/persistence/illegal-re-export.ts':
        "export type { WorkEventData } from '../work/index.js';",
    });

    const diagnostics = await checker.checkEventArchitecture(root);
    expect(
      diagnostics.filter(({ message }) => message.includes('[bounded-event-import-owner]')),
    ).toHaveLength(2);
  });

  it('rejects direct bounded EventData construction in Bootstrap and Persistence', async () => {
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
    });

    const diagnostics = await checker.checkEventArchitecture(root);
    expect(
      diagnostics.filter(({ message }) => message.includes('[bounded-event-data-construction]')),
    ).toHaveLength(2);
  });

  it('does not treat a factory path as an owner without a manifest event namespace', async () => {
    const root = await fixture(
      {
        'src/reporting/contracts/event-factory.ts': [
          "import { createEventData } from '@atolis-hq/eventing';",
          `export const event = createEventData(${eventInput('reporting.created')});`,
        ].join('\n'),
      },
      { reporting: [] },
    );

    const diagnostics = await checker.checkEventArchitecture(root);
    expect(messages(diagnostics)).toContain('[event-data-factory-owner]');
  });
});
