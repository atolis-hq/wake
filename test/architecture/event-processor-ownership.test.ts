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
    'src/eventing/index.ts': [
      "export { EventProcessorHost } from './application/event-processor-host.js';",
      "export { EventProcessorRuntime } from './application/event-processor-runtime.js';",
      "export { defineEventProcessor, defineBatchEventProcessor } from './contracts/event-processor.js';",
      "export type { EventProcessorDefinition } from './contracts/event-processor.js';",
    ].join('\n'),
    'src/eventing/application/event-processor-host.ts':
      'export class EventProcessorHost { constructor(...args: unknown[]) { void args; } }',
    'src/eventing/application/event-processor-runtime.ts':
      'export class EventProcessorRuntime { constructor(...args: unknown[]) { void args; } }',
    'src/eventing/contracts/event-processor.ts': [
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
      'export type { RegisteredEventProcessor };',
      'export function defineEventProcessor(value: unknown) { return value; }',
      'export function defineBatchEventProcessor(value: unknown) { return value; }',
    ].join('\n'),
    'src/eventing/application/projection-processor.ts':
      'export function createProjectionProcessor(value: unknown) { return value; }',
    'src/persistence/index.ts': [
      "export { createFileProcessorRunSerialiser, createInMemoryProcessorRunSerialiser } from './application/processor-run-serialiser.js';",
    ].join('\n'),
    'src/persistence/application/processor-run-serialiser.ts': [
      'export function createFileProcessorRunSerialiser(value: unknown) { return value; }',
      'export function createInMemoryProcessorRunSerialiser(value: unknown) { return value; }',
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

function messages(diagnostics: readonly Diagnostic[]): string {
  return diagnostics.map(({ message }) => message).join('\n');
}

describe('event processor ownership', () => {
  it('rejects host construction outside Eventing and Bootstrap', async () => {
    const root = await fixture({
      'src/orchestration/application/illegal-host.ts': [
        "import { EventProcessorHost } from '../../eventing/index.js';",
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
        "import type { EventProcessorHost, EventProcessorRuntime } from '../../eventing/index.js';",
        "import type { createFileProcessorRunSerialiser } from '../../persistence/index.js';",
        'export type RuntimeTypes = EventProcessorHost | EventProcessorRuntime | typeof createFileProcessorRunSerialiser;',
      ].join('\n'),
    });

    await expect(checker.checkEventArchitecture(root)).resolves.toEqual([]);
  });

  it('rejects aliased host, registry, and serialiser construction', async () => {
    const root = await fixture({
      'src/orchestration/application/illegal-aliases.ts': [
        "import { EventProcessorHost as Host } from '../../eventing/index.js';",
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
        "import { EventProcessorHost } from '../../eventing/index.js';",
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
        "import { EventProcessorHost } from '../../eventing/index.js';",
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
        "import { EventProcessorHost } from '../../eventing/index.js';",
        "import * as Eventing from '../../eventing/index.js';",
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
        "import { defineEventProcessor } from '../../eventing/index.js';",
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

  it('does not treat an uncalled nested factory assignment as the origin of a later local call', async () => {
    const root = await fixture({
      'src/persistence/application/nested-factory-reference.ts': [
        "import { defineEventProcessor } from '../../eventing/index.js';",
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
        "import { defineEventProcessor } from '../../eventing/index.js';",
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
        "import { defineEventProcessor } from '../../eventing/index.js';",
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
      "import type { EventProcessorDefinition } from '../../eventing/index.js';",
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
      "import type { EventProcessorDefinition } from '../../eventing/index.js';",
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
        "import { defineEventProcessor as define } from '../../eventing/index.js';",
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
        "import { defineEventProcessor } from '../../eventing/index.js';",
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
      "import { EventProcessorHost } from '../../eventing/index.js';",
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
        "import { defineEventProcessor } from '../../eventing/index.js';",
        'export const processor = defineEventProcessor({ handle: async () => undefined });',
      ].join('\n'),
      'src/bootstrap/composition-root.ts': [
        "import { EventProcessorRuntime } from '../eventing/index.js';",
        'export const runtime = new EventProcessorRuntime({}, {}, () => undefined);',
      ].join('\n'),
    });

    await expect(checker.checkEventArchitecture(root)).resolves.toEqual([]);
  });

  it('passes the production source tree', { timeout: 30_000 }, async () => {
    const diagnostics = await checker.checkEventArchitecture('src');
    expect(diagnostics).toEqual([]);
  });
});
