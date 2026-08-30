import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

interface Diagnostic {
  readonly message: string;
}

type CheckEventProcessorArchitecture = (root: string) => Promise<readonly Diagnostic[]>;

const checker = (await import('../../scripts/check-event-processor-architecture.mjs')) as {
  readonly checkEventProcessorArchitecture: CheckEventProcessorArchitecture;
};
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wake-event-processor-ownership-'));
  roots.push(root);
  await Promise.all(
    Object.entries(files).map(async ([path, source]) => {
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, source, 'utf8');
    }),
  );
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
        'export const host = new EventProcessorHost(journal, checkpoints, serialise);',
      ].join('\n'),
    });

    const diagnostics = await checker.checkEventProcessorArchitecture(root);
    expect(messages(diagnostics)).toContain('[event-processor-host-owner]');
  });

  it('rejects concrete processor serialisers outside Persistence and Bootstrap', async () => {
    const root = await fixture({
      'src/integrations/github/application/illegal-serialiser.ts': [
        "import { createFileProcessorRunSerialiser } from '../../../../persistence/index.js';",
        'export const serialise = createFileProcessorRunSerialiser(root);',
      ].join('\n'),
    });

    const diagnostics = await checker.checkEventProcessorArchitecture(root);
    expect(messages(diagnostics)).toContain('[processor-serialiser-owner]');
  });

  it('permits type-only runtime references in bounded modules', async () => {
    const root = await fixture({
      'src/orchestration/application/types.ts': [
        "import type { EventProcessorHost, EventProcessorRuntime } from '../../../eventing/index.js';",
        "import type { createFileProcessorRunSerialiser } from '../../../persistence/index.js';",
        'export type RuntimeTypes = EventProcessorHost | EventProcessorRuntime | typeof createFileProcessorRunSerialiser;',
      ].join('\n'),
    });

    await expect(checker.checkEventProcessorArchitecture(root)).resolves.toEqual([]);
  });

  it('rejects aliased host, registry, and serialiser construction', async () => {
    const root = await fixture({
      'src/orchestration/application/illegal-aliases.ts': [
        "import { EventProcessorHost as Host } from '../../../eventing/index.js';",
        "import { EventProcessorRuntime as Runtime } from '../../../bootstrap/index.js';",
        "import { createFileProcessorRunSerialiser as serialiseFile } from '../../../persistence/index.js';",
        'export const host = new Host(journal, checkpoints, serialise);',
        'export const runtime = new Runtime(journal, checkpoints, serialise);',
        'export const serialiser = serialiseFile(root);',
      ].join('\n'),
    });

    const diagnostics = await checker.checkEventProcessorArchitecture(root);
    expect(messages(diagnostics)).toContain('[event-processor-host-owner]');
    expect(messages(diagnostics)).toContain('[processor-registry-owner]');
    expect(messages(diagnostics)).toContain('[processor-serialiser-owner]');
  });

  it('rejects processor handlers and host composition in Persistence', async () => {
    const root = await fixture({
      'src/persistence/application/illegal-processor.ts': [
        'export const processor = { handle: async () => undefined };',
      ].join('\n'),
      'src/persistence/application/illegal-runtime.ts': [
        "import { EventProcessorRuntime } from '../../bootstrap/index.js';",
        'export const runtime = new EventProcessorRuntime(journal, checkpoints, serialise);',
      ].join('\n'),
    });

    const diagnostics = await checker.checkEventProcessorArchitecture(root);
    expect(messages(diagnostics)).toContain('[persistence-processor-handler]');
    expect(messages(diagnostics)).toContain('[processor-registry-owner]');
  });

  it('rejects computed, shorthand, and factory-linked handlers in Persistence', async () => {
    const root = await fixture({
      'src/persistence/application/computed-handler.ts': [
        'const handle = async () => undefined;',
        'const handler = () => undefined;',
        "export const processor = { ['handle']: handle, handler };",
        'export const factory = () => ({ handle });',
      ].join('\n'),
    });

    const diagnostics = await checker.checkEventProcessorArchitecture(root);
    expect(
      diagnostics.filter(({ message }) => message.includes('[persistence-processor-handler]')),
    ).not.toHaveLength(0);
  });

  it('permits definitions in bounded modules and composition in Bootstrap', async () => {
    const root = await fixture({
      'src/orchestration/application/processor.ts': [
        "import { defineEventProcessor } from '../../../eventing/index.js';",
        'export const processor = defineEventProcessor({ handle: async () => undefined });',
      ].join('\n'),
      'src/bootstrap/composition-root.ts': [
        "import { EventProcessorRuntime } from '../eventing/index.js';",
        'export const runtime = new EventProcessorRuntime(journal, checkpoints, serialise);',
      ].join('\n'),
    });

    await expect(checker.checkEventProcessorArchitecture(root)).resolves.toEqual([]);
  });

  it('passes the production source tree', async () => {
    const diagnostics = await checker.checkEventProcessorArchitecture('src');
    expect(diagnostics).toEqual([]);
  });
});
