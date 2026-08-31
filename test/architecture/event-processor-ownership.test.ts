import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { assertTypeScriptFixtureCompiles } from './support/typescript-fixture.js';

interface Diagnostic {
  readonly message: string;
}

type CheckEventArchitecture = (root: string) => Promise<readonly Diagnostic[]>;

interface AnalysisStats {
  readonly originEdges: number;
  readonly uniqueOriginStates: number;
}

const checker = (await import('../../scripts/check-event-architecture.mjs')) as {
  readonly checkEventArchitecture: CheckEventArchitecture;
  readonly checkEventArchitectureWithStats?: (
    root: string,
  ) => Promise<{ readonly diagnostics: readonly Diagnostic[]; readonly stats: AnalysisStats }>;
};
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wake-event-processor-ownership-'));
  roots.push(root);
  const runtimeStubs = {
    'packages/eventing/src/index.ts': [
      "export { EventProcessorHost } from './runtime/event-processor-host.js';",
      "export { defineEventProcessor, createBatchEventProcessor } from './subscriptions/event-processor.js';",
      "export type { EventProcessorDefinition, BatchEventProcessorDefinition } from './subscriptions/event-processor.js';",
    ].join('\n'),
    'packages/eventing/src/runtime/event-processor-host.ts':
      'export class EventProcessorHost { constructor(...args: unknown[]) { void args; } }',
    'packages/eventing/src/subscriptions/event-processor.ts': [
      'export interface EventProcessorDefinition<Message> {',
      '  readonly consumer: string;',
      '  readonly name: string;',
      '  readonly owner: string;',
      '  readonly category: string;',
      '  readonly replayPolicy: string;',
      '  readonly select: (event: unknown) => Message | null;',
      '  readonly handle: (message: Message, event: unknown, signal: AbortSignal) => Promise<void>;',
      '}',
      'export interface BatchEventProcessorDefinition { readonly handle: (events: readonly unknown[]) => Promise<void>; }',
      'type RegisteredEventProcessor = EventProcessorDefinition<any>;',
      'export type { RegisteredEventProcessor };',
      'export function defineEventProcessor(value: unknown) { return value; }',
      'export function createBatchEventProcessor(value: unknown) { return value; }',
    ].join('\n'),
    'packages/eventing/src/projections/projection-processor.ts':
      'export function createProjectionProcessor(value: unknown) { return value; }',
    'src/persistence/index.ts': [
      "export { createFileProcessorRunSerialiser } from './application/processor-run-serialiser.js';",
    ].join('\n'),
    'src/persistence/application/processor-run-serialiser.ts': [
      'export function createFileProcessorRunSerialiser(value: unknown) { return value; }',
    ].join('\n'),
    'src/bootstrap/index.ts':
      "export { EventProcessorRuntime } from './event-processor-runtime.js';",
    'src/bootstrap/event-processor-runtime.ts':
      'export class EventProcessorRuntime { constructor(...args: unknown[]) { void args; } }',
  };
  await Promise.all(
    Object.entries({ ...runtimeStubs, ...files }).map(async ([path, source]) => {
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, source, 'utf8');
    }),
  );
  await assertTypeScriptFixtureCompiles(root);
  return root;
}

async function publishedDeclarationFixture(
  files: Readonly<Record<string, string>>,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wake-event-processor-published-'));
  roots.push(root);
  const stubs = {
    'node_modules/@atolis-hq/eventing/package.json': JSON.stringify({
      name: '@atolis-hq/eventing',
      type: 'module',
      exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
    }),
    'node_modules/@atolis-hq/eventing/dist/index.d.ts': [
      "export { EventProcessorHost } from './runtime/event-processor-host.js';",
      "export type { EventProcessorDefinition } from './subscriptions/event-processor.js';",
    ].join('\n'),
    'node_modules/@atolis-hq/eventing/dist/runtime/event-processor-host.d.ts':
      'export declare class EventProcessorHost { constructor(...args: unknown[]); }',
    'node_modules/@atolis-hq/eventing/dist/subscriptions/event-processor.d.ts': [
      'export interface EventProcessorDefinition<Message> {',
      '  readonly consumer: string;',
      '  readonly name: string;',
      '  readonly owner: string;',
      '  readonly category: string;',
      '  readonly replayPolicy: string;',
      '  readonly select: (event: unknown) => Message | null;',
      '  readonly handle: (message: Message, event: unknown, signal: AbortSignal) => Promise<void>;',
      '}',
      'type RegisteredEventProcessor = EventProcessorDefinition<any>;',
      'export type EventProcessor = RegisteredEventProcessor;',
      'export declare function defineEventProcessor<Message>(definition: EventProcessorDefinition<Message>): EventProcessor;',
    ].join('\n'),
    ...files,
  };
  await Promise.all(
    Object.entries(stubs).map(async ([path, source]) => {
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, source, 'utf8');
    }),
  );
  await assertTypeScriptFixtureCompiles(root);
  return root;
}

function messages(diagnostics: readonly Diagnostic[]): string {
  return diagnostics.map(({ message }) => message).join('\n');
}

describe('event processor ownership', () => {
  it('enforces host ownership through the public Eventing package', async () => {
    const root = await fixture({
      'src/orchestration/application/illegal-public-host.ts': [
        "import { EventProcessorHost } from '@atolis-hq/eventing';",
        'export const host = new EventProcessorHost();',
      ].join('\n'),
      'src/bootstrap/allowed-public-host.ts': [
        "import { EventProcessorHost } from '@atolis-hq/eventing';",
        'export const host = new EventProcessorHost();',
      ].join('\n'),
    });

    const diagnostics = await checker.checkEventArchitecture(root);
    expect(
      diagnostics
        .filter(({ message }) => message.includes('[event-processor-host-owner]'))
        .map(({ message }) => message.split(' ')[0]),
    ).toEqual(['orchestration/application/illegal-public-host.ts:2:25']);
  });

  it('enforces host ownership through published Eventing declarations', async () => {
    const root = await publishedDeclarationFixture({
      'src/orchestration/application/illegal-published-host.ts': [
        "import { EventProcessorHost } from '@atolis-hq/eventing';",
        'export const host = new EventProcessorHost();',
      ].join('\n'),
      'src/bootstrap/allowed-published-host.ts': [
        "import { EventProcessorHost } from '@atolis-hq/eventing';",
        'export const host = new EventProcessorHost();',
      ].join('\n'),
    });

    const diagnostics = await checker.checkEventArchitecture(root);
    expect(
      diagnostics
        .filter(({ message }) => message.includes('[event-processor-host-owner]'))
        .map(({ message }) => message.split(' ')[0]),
    ).toEqual(['orchestration/application/illegal-published-host.ts:2:25']);
  });

  it('rejects structurally compatible Persistence processors using declarations only', async () => {
    const root = await publishedDeclarationFixture({
      'src/persistence/application/structural-published-processor.ts': [
        'export const processor = {',
        "  consumer: 'consumer',",
        "  name: 'name',",
        "  owner: 'owner',",
        "  category: 'projection',",
        "  replayPolicy: 'rebuildable',",
        "  select: (_event: unknown) => 'message',",
        '  handle: async (_message: string, _event: unknown, _signal: AbortSignal) => undefined,',
        '};',
      ].join('\n'),
    });

    const diagnostics = await checker.checkEventArchitecture(root);
    expect(
      diagnostics
        .filter(({ message }) => message.includes('[persistence-processor-handler]'))
        .map(({ message }) => message.split(' ')[0]),
    ).toEqual(['persistence/application/structural-published-processor.ts:1:26']);
  });

  it('rejects host construction outside Eventing and Bootstrap', async () => {
    const root = await fixture({
      'src/orchestration/application/illegal-host.ts': [
        "import { EventProcessorHost } from '@atolis-hq/eventing';",
        'export const host = new EventProcessorHost({}, {}, () => undefined);',
      ].join('\n'),
    });

    const diagnostics = await checker.checkEventArchitecture(root);
    expect(messages(diagnostics)).toContain('[event-processor-host-owner]');
  });

  it('rejects concrete processor serialisers outside Persistence and Bootstrap', async () => {
    const root = await fixture({
      'src/integrations/github/application/illegal-serialiser.ts': [
        "import { createFileProcessorRunSerialiser } from '../../../persistence/index.js';",
        "export const serialise = createFileProcessorRunSerialiser('/tmp');",
      ].join('\n'),
    });

    const diagnostics = await checker.checkEventArchitecture(root);
    expect(messages(diagnostics)).toContain('[processor-serialiser-owner]');
  });

  it('permits type-only runtime references in bounded modules', async () => {
    const root = await fixture({
      'src/orchestration/application/types.ts': [
        "import type { EventProcessorHost } from '@atolis-hq/eventing';",
        "import type { EventProcessorRuntime } from '../../bootstrap/index.js';",
        "import type { createFileProcessorRunSerialiser } from '../../persistence/index.js';",
        'export type RuntimeTypes = EventProcessorHost | EventProcessorRuntime | typeof createFileProcessorRunSerialiser;',
      ].join('\n'),
    });

    await expect(checker.checkEventArchitecture(root)).resolves.toEqual([]);
  });

  it('rejects aliased host, registry, and serialiser construction', async () => {
    const root = await fixture({
      'src/orchestration/application/illegal-aliases.ts': [
        "import { EventProcessorHost as Host } from '@atolis-hq/eventing';",
        "import { EventProcessorRuntime as Runtime } from '../../bootstrap/index.js';",
        "import { createFileProcessorRunSerialiser as serialiseFile } from '../../persistence/index.js';",
        'export const host = new Host({}, {}, () => undefined);',
        'const HostAlias = Host;',
        'export const chainedHost = new HostAlias({}, {}, () => undefined);',
        'export const runtime = new Runtime({}, {}, () => undefined);',
        'const RuntimeAlias = Runtime;',
        'export const chainedRuntime = new RuntimeAlias({}, {}, () => undefined);',
        "export const serialiser = serialiseFile('/tmp');",
        'const serialiserAlias = serialiseFile;',
        "export const chainedSerialiser = serialiserAlias('/tmp');",
      ].join('\n'),
    });

    const diagnostics = await checker.checkEventArchitecture(root);
    expect(messages(diagnostics)).toContain('[event-processor-host-owner]');
    expect(messages(diagnostics)).toContain('[processor-registry-owner]');
    expect(messages(diagnostics)).toContain('[processor-serialiser-owner]');
  });

  it('reports protected constructor references without flagging later local replacements', async () => {
    const root = await fixture({
      'src/orchestration/application/flow-aware-host.ts': [
        "import { EventProcessorHost } from '@atolis-hq/eventing';",
        'class LocalHost { constructor(...args: unknown[]) { void args; } }',
        'let First: typeof EventProcessorHost = EventProcessorHost;',
        'export const firstProtected = new First();',
        'First = LocalHost;',
        'export const firstLocal = new First();',
        'let Second: typeof EventProcessorHost = LocalHost;',
        'export const secondLocal = new Second();',
        'Second = EventProcessorHost;',
        'export const secondProtected = new Second();',
      ].join('\n'),
    });

    const diagnostics = await checker.checkEventArchitecture(root);
    expect(
      diagnostics
        .filter(({ message }) => message.includes('[event-processor-host-owner]'))
        .map(({ message }) => message.split(' ')[0]),
    ).toEqual([
      'orchestration/application/flow-aware-host.ts:3:40',
      'orchestration/application/flow-aware-host.ts:9:10',
    ]);
  });

  it('reports protected constructor references inside conditional, loop, nested, and passing flows', async () => {
    const root = await fixture({
      'src/orchestration/application/control-flow-host-references.ts': [
        "import { EventProcessorHost } from '@atolis-hq/eventing';",
        'class LocalHost { constructor(...args: unknown[]) { void args; } }',
        'declare const condition: boolean;',
        'let Conditional = LocalHost;',
        'if (condition) Conditional = EventProcessorHost;',
        'let Loop = LocalHost;',
        'for (const enabled of [condition]) {',
        '  if (enabled) {',
        '    Loop = EventProcessorHost;',
        '  }',
        '}',
        'let Nested = LocalHost;',
        'function neverCalled() {',
        '  Nested = EventProcessorHost;',
        '}',
        'void neverCalled;',
        'const consume = (_value: unknown): void => undefined;',
        'consume(EventProcessorHost);',
        'Conditional = LocalHost;',
        'Loop = LocalHost;',
        'export const localConditional = new Conditional();',
        'export const localLoop = new Loop();',
        'export const localNested = new Nested();',
      ].join('\n'),
    });

    const diagnostics = await checker.checkEventArchitecture(root);
    expect(
      diagnostics
        .filter(({ message }) => message.includes('[event-processor-host-owner]'))
        .map(({ message }) => message.split(' ')[0]),
    ).toEqual([
      'orchestration/application/control-flow-host-references.ts:5:30',
      'orchestration/application/control-flow-host-references.ts:9:12',
      'orchestration/application/control-flow-host-references.ts:14:12',
      'orchestration/application/control-flow-host-references.ts:18:9',
    ]);
  });

  it('applies runtime-reference ownership to the complete processor infrastructure symbol set', async () => {
    const root = await fixture({
      'src/orchestration/application/illegal-runtime-references.ts': [
        "import { EventProcessorHost } from '@atolis-hq/eventing';",
        "import * as Eventing from '@atolis-hq/eventing';",
        "import { EventProcessorRuntime } from '../../bootstrap/index.js';",
        "import { createFileProcessorRunSerialiser } from '../../persistence/index.js';",
        'const consume = (_value: unknown): void => undefined;',
        'consume(EventProcessorHost);',
        "const hostKey = 'EventProcessorHost' as const;",
        'const namespacedHost = Eventing.EventProcessorHost;',
        'const computedHost = Eventing[hostKey];',
        'const runtime = EventProcessorRuntime;',
        'const serialiser = createFileProcessorRunSerialiser;',
        'export { computedHost, namespacedHost, runtime, serialiser };',
      ].join('\n'),
      'src/persistence/application/illegal-factory-references.ts': [
        "import { defineEventProcessor } from '@atolis-hq/eventing';",
        'const consume = (_value: unknown): void => undefined;',
        'const stored = defineEventProcessor;',
        'consume(defineEventProcessor);',
        'export { stored };',
      ].join('\n'),
    });

    const diagnostics = await checker.checkEventArchitecture(root);
    expect(
      diagnostics
        .filter(({ message }) => message.includes('[event-processor-host-owner]'))
        .map(({ message }) => message.split(' ')[0]),
    ).toEqual([
      'orchestration/application/illegal-runtime-references.ts:6:9',
      'orchestration/application/illegal-runtime-references.ts:8:33',
      'orchestration/application/illegal-runtime-references.ts:9:22',
    ]);
    expect(
      diagnostics.filter(({ message }) => message.includes('[processor-registry-owner]')),
    ).toHaveLength(1);
    expect(
      diagnostics.filter(({ message }) => message.includes('[processor-serialiser-owner]')),
    ).toHaveLength(1);
    expect(
      diagnostics.filter(({ message }) => message.includes('[persistence-processor-handler]')),
    ).toHaveLength(2);
  });

  it('rejects protected processor bindings carried through structural defaults and rest paths', async () => {
    const root = await fixture({
      'src/orchestration/application/structural-host-bindings.ts': [
        "import * as Eventing from '@atolis-hq/eventing';",
        'class LocalHost { constructor(...args: unknown[]) { void args; } }',
        'const { EventProcessorHost = class {} } = Eventing;',
        'const { EventProcessorHost: RenamedHost = LocalHost } = Eventing;',
        "const hostKey = 'EventProcessorHost' as const;",
        'const { [hostKey]: ComputedHost = LocalHost } = Eventing;',
        'let AssignedHost: typeof Eventing.EventProcessorHost = LocalHost;',
        '({ EventProcessorHost: AssignedHost = LocalHost } = Eventing);',
        'let ComputedAssignedHost: typeof Eventing.EventProcessorHost = LocalHost;',
        '({ [hostKey]: ComputedAssignedHost = LocalHost } = Eventing);',
        'const { ...EventingRest } = Eventing;',
        'const [...namespaces]: [typeof Eventing] = [Eventing];',
        'export const hosts = [',
        '  new EventProcessorHost(),',
        '  new RenamedHost(),',
        '  new ComputedHost(),',
        '  new AssignedHost(),',
        '  new ComputedAssignedHost(),',
        '  new EventingRest.EventProcessorHost(),',
        '  new namespaces[0].EventProcessorHost(),',
        '];',
      ].join('\n'),
      'src/persistence/application/structural-factory-bindings.ts': [
        "import * as Eventing from '@atolis-hq/eventing';",
        'const localFactory = (value: unknown): unknown => value;',
        'const { defineEventProcessor = (value: unknown): unknown => value } = Eventing;',
        'const { defineEventProcessor: RenamedFactory = localFactory } = Eventing;',
        "const factoryKey = 'defineEventProcessor' as const;",
        'const { [factoryKey]: ComputedFactory = localFactory } = Eventing;',
        'let AssignedFactory: typeof Eventing.defineEventProcessor = localFactory;',
        '({ defineEventProcessor: AssignedFactory = localFactory } = Eventing);',
        'let ComputedAssignedFactory: typeof Eventing.defineEventProcessor = localFactory;',
        '({ [factoryKey]: ComputedAssignedFactory = localFactory } = Eventing);',
        'const { ...EventingRest } = Eventing;',
        'const [...namespaces]: [typeof Eventing] = [Eventing];',
        'export const definitions = [',
        '  defineEventProcessor(1),',
        '  RenamedFactory(2),',
        '  ComputedFactory(3),',
        '  AssignedFactory(4),',
        '  ComputedAssignedFactory(5),',
        '  EventingRest.defineEventProcessor(6),',
        "  namespaces[0]['defineEventProcessor'](7),",
        '];',
      ].join('\n'),
    });

    const diagnostics = await checker.checkEventArchitecture(root);
    expect(
      diagnostics
        .filter(({ message }) => message.includes('[event-processor-host-owner]'))
        .map(({ message }) => message.split(' ')[0]),
    ).toEqual([
      'orchestration/application/structural-host-bindings.ts:3:9',
      'orchestration/application/structural-host-bindings.ts:4:29',
      'orchestration/application/structural-host-bindings.ts:6:20',
      'orchestration/application/structural-host-bindings.ts:8:24',
      'orchestration/application/structural-host-bindings.ts:10:15',
      'orchestration/application/structural-host-bindings.ts:19:20',
      'orchestration/application/structural-host-bindings.ts:20:21',
    ]);
    expect(
      diagnostics
        .filter(({ message }) => message.includes('[persistence-processor-handler]'))
        .map(({ message }) => message.split(' ')[0]),
    ).toEqual([
      'persistence/application/structural-factory-bindings.ts:3:9',
      'persistence/application/structural-factory-bindings.ts:4:31',
      'persistence/application/structural-factory-bindings.ts:6:23',
      'persistence/application/structural-factory-bindings.ts:8:26',
      'persistence/application/structural-factory-bindings.ts:10:18',
      'persistence/application/structural-factory-bindings.ts:19:16',
      'persistence/application/structural-factory-bindings.ts:20:3',
    ]);
  });

  it('rejects shorthand and nested-array assignment defaults at their bound targets', async () => {
    const root = await fixture({
      'src/orchestration/application/assignment-default-bindings.ts': [
        "import * as Eventing from '@atolis-hq/eventing';",
        'class LocalHost { constructor(...args: unknown[]) { void args; } }',
        'let EventProcessorHost: typeof Eventing.EventProcessorHost = LocalHost;',
        '({ EventProcessorHost = LocalHost } = Eventing);',
        'let ArrayHost: typeof Eventing.EventProcessorHost = LocalHost;',
        '([{ EventProcessorHost: ArrayHost = LocalHost }] = [Eventing]);',
        'export const hosts = [new EventProcessorHost(), new ArrayHost()];',
      ].join('\n'),
      'src/persistence/application/assignment-default-bindings.ts': [
        "import * as Eventing from '@atolis-hq/eventing';",
        'const localFactory = (value: unknown): unknown => value;',
        'let defineEventProcessor: typeof Eventing.defineEventProcessor = localFactory;',
        '({ defineEventProcessor = localFactory } = Eventing);',
        'let ArrayFactory: typeof Eventing.defineEventProcessor = localFactory;',
        '([{ defineEventProcessor: ArrayFactory = localFactory }] = [Eventing]);',
        'export const values = [defineEventProcessor(1), ArrayFactory(2)];',
      ].join('\n'),
    });

    const diagnostics = await checker.checkEventArchitecture(root);
    expect(
      diagnostics
        .filter(({ message }) => message.includes('[event-processor-host-owner]'))
        .map(({ message }) => message.split(' ')[0]),
    ).toEqual([
      'orchestration/application/assignment-default-bindings.ts:4:4',
      'orchestration/application/assignment-default-bindings.ts:6:25',
    ]);
    expect(
      diagnostics
        .filter(({ message }) => message.includes('[persistence-processor-handler]'))
        .map(({ message }) => message.split(' ')[0]),
    ).toEqual([
      'persistence/application/assignment-default-bindings.ts:4:4',
      'persistence/application/assignment-default-bindings.ts:6:27',
    ]);
  });

  it('rejects destructuring assignments that store protected symbols in member targets', async () => {
    const root = await fixture({
      'src/orchestration/application/member-assignment-targets.ts': [
        "import * as Bootstrap from '../../bootstrap/index.js';",
        "import * as Eventing from '@atolis-hq/eventing';",
        "import * as Persistence from '../../persistence/index.js';",
        'class LocalHost { constructor(...args: unknown[]) { void args; } }',
        'class LocalRuntime { constructor(...args: unknown[]) { void args; } }',
        'const localSerialiser = (value: unknown): unknown => value;',
        'const holder = { Host: LocalHost, ComputedHost: LocalHost, Runtime: LocalRuntime, Serialiser: localSerialiser };',
        '({ EventProcessorHost: holder.Host } = Eventing);',
        "const hostSlot = 'ComputedHost' as const;",
        '({ EventProcessorHost: holder[hostSlot] } = Eventing);',
        '[holder.Host] = [Eventing.EventProcessorHost];',
        '({ nested: [{ EventProcessorRuntime: holder.Runtime }] } = { nested: [Bootstrap] });',
        '({ nested: [{ createFileProcessorRunSerialiser: holder.Serialiser }] } = { nested: [Persistence] });',
        'export const values = [new holder.Host(), new holder.ComputedHost(), new holder.Runtime(), holder.Serialiser(1)];',
      ].join('\n'),
      'src/persistence/application/member-assignment-targets.ts': [
        "import * as Eventing from '@atolis-hq/eventing';",
        'const localFactory = (value: unknown): unknown => value;',
        'const holders: [typeof Eventing.defineEventProcessor, typeof Eventing.defineEventProcessor] = [localFactory, localFactory];',
        '({ defineEventProcessor: holders[0] } = Eventing);',
        '([{ defineEventProcessor: holders[1] }] = [Eventing]);',
        'export const values = [holders[0](1), holders[1](2)];',
      ].join('\n'),
    });

    const diagnostics = await checker.checkEventArchitecture(root);
    expect(
      diagnostics
        .filter(({ message }) => message.includes('[event-processor-host-owner]'))
        .map(({ message }) => message.split(' ')[0]),
    ).toEqual([
      'orchestration/application/member-assignment-targets.ts:8:24',
      'orchestration/application/member-assignment-targets.ts:10:24',
      'orchestration/application/member-assignment-targets.ts:11:27',
    ]);
    expect(
      diagnostics
        .filter(({ message }) => message.includes('[processor-registry-owner]'))
        .map(({ message }) => message.split(' ')[0]),
    ).toEqual(['orchestration/application/member-assignment-targets.ts:12:38']);
    expect(
      diagnostics
        .filter(({ message }) => message.includes('[processor-serialiser-owner]'))
        .map(({ message }) => message.split(' ')[0]),
    ).toEqual(['orchestration/application/member-assignment-targets.ts:13:49']);
    expect(
      diagnostics
        .filter(({ message }) => message.includes('[persistence-processor-handler]'))
        .map(({ message }) => message.split(' ')[0]),
    ).toEqual([
      'persistence/application/member-assignment-targets.ts:4:26',
      'persistence/application/member-assignment-targets.ts:5:27',
    ]);
  });

  it('does not reject member assignments from local or unprovable dynamic sources', async () => {
    const root = await fixture({
      'src/orchestration/application/local-member-assignment-targets.ts': [
        'class LocalHost { constructor(...args: unknown[]) { void args; } }',
        'const LocalEventing = { EventProcessorHost: LocalHost };',
        'const holder: { Host: typeof LocalHost; ComputedHost: typeof LocalHost; Dynamic: unknown } = { Host: LocalHost, ComputedHost: LocalHost, Dynamic: undefined };',
        '({ EventProcessorHost: holder.Host } = LocalEventing);',
        "const hostSlot = 'ComputedHost' as const;",
        '({ EventProcessorHost: holder[hostSlot] } = LocalEventing);',
        'declare const dynamicKey: string;',
        'const dynamicSource: Record<string, unknown> = LocalEventing;',
        '({ [dynamicKey]: holder.Dynamic } = dynamicSource);',
        'export const values = [new holder.Host(), new holder.ComputedHost(), holder.Dynamic];',
      ].join('\n'),
      'src/persistence/application/local-member-assignment-targets.ts': [
        'const localFactory = (value: unknown): unknown => value;',
        'const LocalEventing = { defineEventProcessor: localFactory };',
        'const holders: [(value: unknown) => unknown] = [localFactory];',
        '({ defineEventProcessor: holders[0] } = LocalEventing);',
        'declare const dynamicKey: string;',
        'const dynamicSource: Record<string, unknown> = LocalEventing;',
        'const dynamicHolder: [unknown] = [undefined];',
        '({ [dynamicKey]: dynamicHolder[0] } = dynamicSource);',
        'export const values = [holders[0](1), dynamicHolder[0]];',
      ].join('\n'),
    });

    await expect(checker.checkEventArchitecture(root)).resolves.toEqual([]);
  });

  it('rejects member rest targets that store protected structural values', async () => {
    const root = await fixture({
      'src/orchestration/application/member-rest-targets.ts': [
        "import * as Bootstrap from '../../bootstrap/index.js';",
        "import * as Eventing from '@atolis-hq/eventing';",
        "import * as Persistence from '../../persistence/index.js';",
        'class LocalHost { constructor(...args: unknown[]) { void args; } }',
        'class LocalRuntime { constructor(...args: unknown[]) { void args; } }',
        'const localSerialiser = (value: unknown): unknown => value;',
        'const holder = {',
        '  namespace: { EventProcessorHost: LocalHost },',
        '  registry: { EventProcessorRuntime: LocalRuntime },',
        '  serialisers: { createFileProcessorRunSerialiser: localSerialiser },',
        '};',
        '({...holder.namespace} = Eventing);',
        '({ nested: { ...holder.registry } } = { nested: Bootstrap });',
        "const serialiserSlot = 'serialisers' as const;",
        '({...holder[serialiserSlot]} = Persistence);',
        'export const values = [new holder.namespace.EventProcessorHost(), new holder.registry.EventProcessorRuntime(), holder.serialisers.createFileProcessorRunSerialiser(1)];',
      ].join('\n'),
      'src/persistence/application/member-rest-targets.ts': [
        "import * as Eventing from '@atolis-hq/eventing';",
        'const localFactory = (value: unknown): unknown => value;',
        'const tupleNamespaces: [typeof Eventing] = [Eventing];',
        'const holder = { namespaces: [] as Array<{ defineEventProcessor: typeof localFactory }>, tupleNamespaces: [] as Array<{ defineEventProcessor: typeof localFactory }> };',
        '[...holder.namespaces] = [Eventing];',
        "const tupleSlot = 'tupleNamespaces' as const;",
        '[...holder[tupleSlot]] = tupleNamespaces;',
        'export const definitions = [holder.namespaces[0]!.defineEventProcessor(1), holder.tupleNamespaces[0]!.defineEventProcessor(2)];',
      ].join('\n'),
    });

    const diagnostics = await checker.checkEventArchitecture(root);
    expect(
      diagnostics
        .filter(({ message }) => message.includes('[event-processor-host-owner]'))
        .map(({ message }) => message.split(' ')[0]),
    ).toEqual([
      'orchestration/application/member-rest-targets.ts:12:6',
      'persistence/application/member-rest-targets.ts:5:5',
      'persistence/application/member-rest-targets.ts:7:5',
    ]);
    expect(
      diagnostics
        .filter(({ message }) => message.includes('[processor-registry-owner]'))
        .map(({ message }) => message.split(' ')[0]),
    ).toEqual(['orchestration/application/member-rest-targets.ts:13:17']);
    expect(
      diagnostics
        .filter(({ message }) => message.includes('[processor-serialiser-owner]'))
        .map(({ message }) => message.split(' ')[0]),
    ).toEqual(['orchestration/application/member-rest-targets.ts:15:6']);
    expect(
      diagnostics
        .filter(({ message }) => message.includes('[persistence-processor-handler]'))
        .map(({ message }) => message.split(' ')[0]),
    ).toEqual([
      'persistence/application/member-rest-targets.ts:5:5',
      'persistence/application/member-rest-targets.ts:7:5',
    ]);
  });

  it('expands finite tuple spreads stored through member rest targets', async () => {
    const root = await fixture({
      'src/persistence/application/finite-tuple-spread-member-rest.ts': [
        "import * as Eventing from '@atolis-hq/eventing';",
        'const localFactory = (value: unknown): unknown => value;',
        'const LocalEventing = { defineEventProcessor: localFactory };',
        'const sources: [typeof Eventing] = [Eventing];',
        'const tupleHolder = { tuples: [Eventing] as [typeof Eventing] };',
        "const tupleSlot = 'tuples' as const;",
        'const before: [typeof LocalEventing] = [LocalEventing];',
        'const after: [typeof LocalEventing] = [LocalEventing];',
        'const holder = { namespaces: [] as Array<{ defineEventProcessor: typeof localFactory }>, nested: [] as Array<{ defineEventProcessor: typeof localFactory }>, computed: [] as Array<{ defineEventProcessor: typeof localFactory }>, offset: [] as Array<{ defineEventProcessor: typeof localFactory }> };',
        '[...holder.namespaces] = [...sources];',
        '[...holder.nested] = [...[...sources]];',
        '[...holder.computed] = [...tupleHolder[tupleSlot]];',
        '[, ...holder.offset] = [...before, ...sources, ...after];',
        'export const values = [holder.namespaces[0]!.defineEventProcessor(1), holder.nested[0]!.defineEventProcessor(2), holder.computed[0]!.defineEventProcessor(3), holder.offset[0]!.defineEventProcessor(4)];',
      ].join('\n'),
    });

    const diagnostics = await checker.checkEventArchitecture(root);
    expect(diagnostics).toHaveLength(8);
    expect(
      diagnostics
        .filter(({ message }) => message.includes('[event-processor-host-owner]'))
        .map(({ message }) => message.split(' ')[0]),
    ).toEqual([
      'persistence/application/finite-tuple-spread-member-rest.ts:10:5',
      'persistence/application/finite-tuple-spread-member-rest.ts:11:5',
      'persistence/application/finite-tuple-spread-member-rest.ts:12:5',
      'persistence/application/finite-tuple-spread-member-rest.ts:13:7',
    ]);
    expect(
      diagnostics
        .filter(({ message }) => message.includes('[persistence-processor-handler]'))
        .map(({ message }) => message.split(' ')[0]),
    ).toEqual([
      'persistence/application/finite-tuple-spread-member-rest.ts:10:5',
      'persistence/application/finite-tuple-spread-member-rest.ts:11:5',
      'persistence/application/finite-tuple-spread-member-rest.ts:12:5',
      'persistence/application/finite-tuple-spread-member-rest.ts:13:7',
    ]);
  });

  it('does not expand dynamic, cyclic, or unrelated local tuple spreads', async () => {
    const root = await fixture({
      'src/persistence/application/unprovable-tuple-spread-member-rest.ts': [
        "import * as Eventing from '@atolis-hq/eventing';",
        'const localFactory = (value: unknown): unknown => value;',
        'const LocalEventing = { EventProcessorHost: class {}, defineEventProcessor: localFactory };',
        'const localSources: [typeof LocalEventing] = [LocalEventing];',
        'declare const dynamicSources: Array<typeof Eventing>;',
        'declare const readonlySources: readonly (typeof Eventing)[];',
        'type CyclicTuple = [CyclicTuple];',
        'declare const cyclicSources: CyclicTuple;',
        'const holder = { local: [] as Array<typeof LocalEventing>, dynamic: [] as Array<typeof LocalEventing>, readonly: [] as Array<typeof LocalEventing>, cyclic: [] as unknown[] };',
        '[...holder.local] = [...localSources];',
        '[...holder.dynamic] = [...dynamicSources];',
        '[...holder.readonly] = [...readonlySources];',
        '[...holder.cyclic] = [...cyclicSources];',
        'export const values = [holder.local[0]!.defineEventProcessor(1), holder.dynamic, holder.readonly, holder.cyclic];',
      ].join('\n'),
    });

    await expect(checker.checkEventArchitecture(root)).resolves.toEqual([]);
  });

  it('does not infer runtime processor origins from type-only tuple annotations', async () => {
    const root = await fixture({
      'src/orchestration/application/type-only-tuple-origins.ts': [
        "import type { EventProcessorHost } from '@atolis-hq/eventing';",
        "import type { createFileProcessorRunSerialiser } from '../../persistence/index.js';",
        'class LocalHost { constructor(...args: unknown[]) { void args; } }',
        'const localSerialiser = (value: unknown): unknown => value;',
        'const hostSources: [typeof EventProcessorHost] = [LocalHost];',
        'const serialiserSources: [typeof createFileProcessorRunSerialiser] = [localSerialiser];',
        'const holder = { hosts: [] as Array<typeof LocalHost>, serialisers: [] as Array<typeof localSerialiser> };',
        '[...holder.hosts] = hostSources;',
        '[...holder.serialisers] = serialiserSources;',
        'export const values = [new holder.hosts[0]!(), holder.serialisers[0]!(1)];',
      ].join('\n'),
      'src/persistence/application/type-only-tuple-origins.ts': [
        "import type { defineEventProcessor } from '@atolis-hq/eventing';",
        'const localFactory = (value: unknown): unknown => value;',
        'const factorySources: [typeof defineEventProcessor] = [localFactory];',
        'const holder = { factories: [] as Array<typeof localFactory> };',
        '[...holder.factories] = factorySources;',
        'export const value = holder.factories[0]!(1);',
      ].join('\n'),
    });

    await expect(checker.checkEventArchitecture(root)).resolves.toEqual([]);
  });

  it('does not reject excluded, local, or unprovable member rest values', async () => {
    const root = await fixture({
      'src/orchestration/application/local-member-rest-targets.ts': [
        "import * as Eventing from '@atolis-hq/eventing';",
        'class LocalHost { constructor(...args: unknown[]) { void args; } }',
        'const LocalEventing = { EventProcessorHost: LocalHost };',
        'const holder = { namespace: { EventProcessorHost: LocalHost }, excludedNamespace: {}, dynamic: {} as Record<string, unknown> };',
        '({...holder.namespace} = LocalEventing);',
        '({ EventProcessorHost: {}, ...holder.excludedNamespace } = Eventing);',
        'declare const dynamicSource: Record<string, unknown>;',
        '({...holder.dynamic} = dynamicSource);',
        'export const values = [new holder.namespace.EventProcessorHost(), holder.excludedNamespace, holder.dynamic];',
      ].join('\n'),
      'src/persistence/application/local-member-rest-targets.ts': [
        'const localFactory = (value: unknown): unknown => value;',
        'const LocalEventing = { defineEventProcessor: localFactory };',
        'const holder = { namespaces: [] as Array<typeof LocalEventing>, dynamic: [] as Array<Record<string, unknown>> };',
        '[...holder.namespaces] = [LocalEventing];',
        'declare const dynamicNamespaces: Array<Record<string, unknown>>;',
        '[...holder.dynamic] = dynamicNamespaces;',
        'export const values = [holder.namespaces[0]!.defineEventProcessor(1), holder.dynamic];',
      ].join('\n'),
    });

    await expect(checker.checkEventArchitecture(root)).resolves.toEqual([]);
  });

  it('does not reject structural defaults and rest paths from unrelated local objects', async () => {
    const root = await fixture({
      'src/orchestration/application/local-structural-bindings.ts': [
        'class LocalHost { constructor(...args: unknown[]) { void args; } }',
        'const LocalEventing = { EventProcessorHost: LocalHost };',
        'const { EventProcessorHost = class {} } = LocalEventing;',
        'const { EventProcessorHost: RenamedHost = LocalHost } = LocalEventing;',
        "const hostKey = 'EventProcessorHost' as const;",
        'const { [hostKey]: ComputedHost = LocalHost } = LocalEventing;',
        'const { ...LocalRest } = LocalEventing;',
        'const [...locals]: [typeof LocalEventing] = [LocalEventing];',
        'const Absent: { EventProcessorHost?: undefined } = {};',
        'const { EventProcessorHost: DefaultHost = LocalHost } = Absent;',
        'export const hosts = [new EventProcessorHost(), new RenamedHost(), new ComputedHost(), new LocalRest.EventProcessorHost(), new locals[0].EventProcessorHost(), new DefaultHost()];',
      ].join('\n'),
      'src/persistence/application/local-structural-bindings.ts': [
        'const localFactory = (value: unknown): unknown => value;',
        'const LocalEventing = { defineEventProcessor: localFactory };',
        'const { defineEventProcessor = (value: unknown): unknown => value } = LocalEventing;',
        'const { defineEventProcessor: RenamedFactory = localFactory } = LocalEventing;',
        "const factoryKey = 'defineEventProcessor' as const;",
        'const { [factoryKey]: ComputedFactory = localFactory } = LocalEventing;',
        'const { ...LocalRest } = LocalEventing;',
        'const [...locals]: [typeof LocalEventing] = [LocalEventing];',
        'const Absent: { defineEventProcessor?: undefined } = {};',
        'const { defineEventProcessor: DefaultFactory = localFactory } = Absent;',
        'export const values = [defineEventProcessor(1), RenamedFactory(2), ComputedFactory(3), LocalRest.defineEventProcessor(4), locals[0].defineEventProcessor(5), DefaultFactory(6)];',
      ].join('\n'),
    });

    await expect(checker.checkEventArchitecture(root)).resolves.toEqual([]);
  });

  it('does not treat an uncalled nested factory assignment as the origin of a later local call', async () => {
    const root = await fixture({
      'src/persistence/application/nested-factory-reference.ts': [
        "import { defineEventProcessor } from '@atolis-hq/eventing';",
        'const localFactory = (value: unknown): unknown => value;',
        'let Factory: typeof defineEventProcessor = localFactory;',
        'function neverCalled() {',
        '  Factory = defineEventProcessor;',
        '}',
        'void neverCalled;',
        'export const unrelated = Factory({ handle: async () => undefined });',
      ].join('\n'),
    });

    const diagnostics = await checker.checkEventArchitecture(root);
    expect(
      diagnostics
        .filter(({ message }) => message.includes('[persistence-processor-handler]'))
        .map(({ message }) => message.split(' ')[0]),
    ).toEqual(['persistence/application/nested-factory-reference.ts:5:13']);
  });

  it('rejects processor handlers and host composition in Persistence', async () => {
    const root = await fixture({
      'src/persistence/application/illegal-processor.ts': [
        "import { defineEventProcessor } from '@atolis-hq/eventing';",
        'export const processor = defineEventProcessor({ handle: async () => undefined });',
      ].join('\n'),
      'src/persistence/application/illegal-runtime.ts': [
        "import { EventProcessorRuntime } from '../../bootstrap/index.js';",
        'export const runtime = new EventProcessorRuntime({}, {}, () => undefined);',
      ].join('\n'),
    });

    const diagnostics = await checker.checkEventArchitecture(root);
    expect(messages(diagnostics)).toContain('[persistence-processor-handler]');
    expect(messages(diagnostics)).toContain('[processor-registry-owner]');
  });

  it('rejects computed, shorthand, and factory-linked handlers in Persistence', async () => {
    const root = await fixture({
      'src/persistence/application/computed-handler.ts': [
        "import { defineEventProcessor } from '@atolis-hq/eventing';",
        'const handle = async () => undefined;',
        'const handler = () => undefined;',
        "export const processor = defineEventProcessor({ ['handle']: handle, handler });",
        'export const factory = () => ({ handle });',
        'export const linked = defineEventProcessor(factory());',
      ].join('\n'),
    });

    const diagnostics = await checker.checkEventArchitecture(root);
    expect(
      diagnostics.filter(({ message }) => message.includes('[persistence-processor-handler]')),
    ).not.toHaveLength(0);
  });

  it('rejects structurally typed processor definition values in Persistence only', async () => {
    const definition = [
      "import type { EventProcessorDefinition } from '@atolis-hq/eventing';",
      "const intermediate = { consumer: 'consumer', name: 'name', owner: 'owner', category: 'projection', replayPolicy: 'rebuildable', select: (_event: unknown) => 'message', handle: async (_message: string, _event: unknown, _signal: AbortSignal) => undefined };",
      'export const assigned: EventProcessorDefinition<string> = intermediate;',
      "export const contextual: EventProcessorDefinition<string> = { consumer: 'contextual', name: 'name', owner: 'owner', category: 'projection', replayPolicy: 'rebuildable', select: (_event) => 'message', handle: async (_message, _event, _signal) => undefined };",
    ].join('\n');
    const root = await fixture({
      'src/persistence/application/typed-definition.ts': definition,
      'src/orchestration/application/typed-definition.ts': definition,
    });

    const diagnostics = await checker.checkEventArchitecture(root);
    expect(
      diagnostics.filter(({ message }) => message.includes('[persistence-processor-handler]')),
    ).toHaveLength(2);
    expect(messages(diagnostics)).not.toContain('orchestration/application/typed-definition.ts');
  });

  it('does not reject a complete but type-incompatible processor definition lookalike', async () => {
    const root = await fixture({
      'src/persistence/application/incompatible-definition-lookalike.ts': [
        'export const lookalike = {',
        '  consumer: 1,',
        '  name: 2,',
        '  owner: 3,',
        '  category: 4,',
        '  replayPolicy: 5,',
        "  select: 'not-a-function',",
        "  handle: 'not-a-function',",
        '};',
      ].join('\n'),
    });

    await expect(checker.checkEventArchitecture(root)).resolves.toEqual([]);
  });

  it('rejects implementing and structurally assignable processor classes in Persistence only', async () => {
    const implementingClass = [
      "import type { EventProcessorDefinition } from '@atolis-hq/eventing';",
      'export class StoredProcessor implements EventProcessorDefinition<string> {',
      "  readonly consumer = 'consumer';",
      "  readonly name = 'name';",
      "  readonly owner = 'owner';",
      "  readonly category = 'projection';",
      "  readonly replayPolicy = 'rebuildable';",
      "  select(_event: unknown): string { return 'message'; }",
      '  async handle(_message: string, _event: unknown, _signal: AbortSignal): Promise<void> {}',
      '}',
    ].join('\n');
    const root = await fixture({
      'src/persistence/application/processor-class.ts': implementingClass,
      'src/persistence/application/processor-class-expression.ts': [
        'export const StoredProcessorExpression = class {',
        "  readonly consumer = 'consumer';",
        "  readonly name = 'name';",
        "  readonly owner = 'owner';",
        "  readonly category = 'projection';",
        "  readonly replayPolicy = 'rebuildable';",
        "  select(_event: unknown): string { return 'message'; }",
        '  async handle(_message: string, _event: unknown, _signal: AbortSignal): Promise<void> {}',
        '};',
      ].join('\n'),
      'src/persistence/application/incompatible-processor-class.ts': [
        'export class IncompatibleProcessor {',
        '  readonly consumer = 1;',
        '  readonly name = 2;',
        '  readonly owner = 3;',
        '  readonly category = 4;',
        '  readonly replayPolicy = 5;',
        "  readonly select = 'not-a-function';",
        "  readonly handle = 'not-a-function';",
        '}',
      ].join('\n'),
      'src/orchestration/application/processor-class.ts': implementingClass,
    });

    const diagnostics = await checker.checkEventArchitecture(root);
    expect(
      diagnostics
        .filter(({ message }) => message.includes('[persistence-processor-handler]'))
        .map(({ message }) => message.split(' ')[0]),
    ).toEqual([
      'persistence/application/processor-class-expression.ts:1:42',
      'persistence/application/processor-class.ts:2:14',
    ]);
    expect(messages(diagnostics)).not.toContain('incompatible-processor-class.ts');
    expect(messages(diagnostics)).not.toContain('orchestration/application/processor-class.ts');
  });

  it('rejects a resolved Eventing processor factory and its linked handler', async () => {
    const root = await fixture({
      'src/persistence/application/factory-handler.ts': [
        "import { defineEventProcessor as define } from '@atolis-hq/eventing';",
        'const handler = async () => undefined;',
        'const makeDefinition = () => ({ handle: handler });',
        'const defineAlias = define;',
        'export const processor = defineAlias(makeDefinition());',
      ].join('\n'),
    });

    const diagnostics = await checker.checkEventArchitecture(root);
    expect(messages(diagnostics)).toContain('[persistence-processor-handler]');
  });

  it('reports linked processor handlers at their defining source file', async () => {
    const root = await fixture({
      'src/persistence/support/definition.ts': [
        'export const makeDefinition = () => ({',
        "  consumer: 'consumer', name: 'name', owner: 'owner', category: 'projection', replayPolicy: 'rebuildable',",
        "  select: (_event: unknown) => 'message',",
        '  handle: async (_message: string, _event: unknown, _signal: AbortSignal) => undefined,',
        '});',
      ].join('\n'),
      'src/persistence/application/cross-file-handler.ts': [
        "import { defineEventProcessor } from '@atolis-hq/eventing';",
        "import { makeDefinition } from '../support/definition.js';",
        'export const processor = defineEventProcessor(makeDefinition());',
      ].join('\n'),
    });

    const diagnostics = await checker.checkEventArchitecture(root);
    expect(messages(diagnostics)).toContain(
      'persistence/support/definition.ts:4:3 [persistence-processor-handler]',
    );
  });

  it('bounds depth-18 alias analysis after reporting its protected reference', async () => {
    const chain = [
      "import { EventProcessorHost } from '@atolis-hq/eventing';",
      'class LocalHost { constructor(...args: unknown[]) { void args; } }',
      'const seed: [typeof EventProcessorHost] = [EventProcessorHost];',
    ];
    let prior = 'seed';
    for (let depth = 1; depth <= 18; depth += 1) {
      chain.push(
        `const [candidate${depth} = LocalHost]: [(typeof EventProcessorHost)?] = ${prior};`,
        `const [...level${depth}]: [typeof EventProcessorHost] = [candidate${depth}];`,
      );
      prior = `level${depth}`;
    }
    chain.push(`export const host = new ${prior}[0]!();`);
    const root = await fixture({
      'src/orchestration/application/deep-origin-graph.ts': chain.join('\n'),
    });

    expect(checker.checkEventArchitectureWithStats).toBeTypeOf('function');
    const analysis = await checker.checkEventArchitectureWithStats?.(root);
    expect(analysis?.diagnostics).toHaveLength(1);
    expect(analysis?.stats).toEqual({ originEdges: 37, uniqueOriginStates: 74 });
  });

  it('permits unrelated local names and generic handler objects in Persistence', async () => {
    const root = await fixture({
      'src/orchestration/application/local-names.ts': [
        'class EventProcessorHost {}',
        'class EventProcessorRuntime {}',
        'const createFileProcessorRunSerialiser = () => undefined;',
        'export const host = new EventProcessorHost();',
        'export const runtime = new EventProcessorRuntime();',
        'export const serialiser = createFileProcessorRunSerialiser();',
      ].join('\n'),
      'src/persistence/application/generic-handler.ts': [
        'const handle = () => undefined;',
        'const handler = () => undefined;',
        "export const unrelated = [{ handle }, { handler }, { ['handle']: handler }];",
      ].join('\n'),
    });

    await expect(checker.checkEventArchitecture(root)).resolves.toEqual([]);
  });

  it('permits definitions in bounded modules and composition in Bootstrap', async () => {
    const root = await fixture({
      'src/orchestration/application/processor.ts': [
        "import { defineEventProcessor } from '@atolis-hq/eventing';",
        'export const processor = defineEventProcessor({ handle: async () => undefined });',
      ].join('\n'),
      'src/bootstrap/composition-root.ts': [
        "import { EventProcessorRuntime } from './event-processor-runtime.js';",
        'export const runtime = new EventProcessorRuntime({}, {}, () => undefined);',
      ].join('\n'),
    });

    await expect(checker.checkEventArchitecture(root)).resolves.toEqual([]);
  });

  it('passes the production source tree', { timeout: 90_000 }, async () => {
    const diagnostics = await checker.checkEventArchitecture('src');
    expect(diagnostics).toEqual([]);
  });
});
