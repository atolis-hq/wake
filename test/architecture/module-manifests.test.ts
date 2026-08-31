import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const modules = [
  'kernel',
  'work',
  'resources',
  'activities',
  'orchestration',
  'execution',
  'control-plane',
  'integrations',
  'surfaces',
  'bootstrap',
] as const;

interface ModuleManifest {
  readonly name: string;
  readonly publicEntry: string;
  readonly namespaces: {
    readonly events: readonly string[];
    readonly config: readonly string[];
    readonly relations: readonly string[];
    readonly streams: readonly string[];
  };
}

type CheckModuleManifests = (root?: string) => Promise<readonly string[]>;

type CheckEventingFilesystemPackage = (root?: string) => Promise<readonly string[]>;

const checkerModulePath = '../../scripts/check-module-manifests.mjs';
const checker = (await import(checkerModulePath)) as {
  readonly checkModuleManifests: CheckModuleManifests;
  readonly checkEventingFilesystemPackage: CheckEventingFilesystemPackage;
};
const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtureRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })),
  );
});

describe('module manifests', () => {
  it.each(modules)('%s has matching human and machine contracts', async (name) => {
    const manifest = JSON.parse(
      await readFile(`src/${name}/module.json`, 'utf8'),
    ) as ModuleManifest;
    const moduleDoc = await readFile(`src/${name}/MODULE.md`, 'utf8');
    expect(manifest.name).toBe(name);
    expect(manifest.publicEntry).toBe('./index.ts');
    expect(manifest.namespaces.streams).toEqual(expect.any(Array));
    expect(moduleDoc).toContain(`# ${name}`);
    expect(moduleDoc).toContain('## Does not own');
    expect(moduleDoc).toContain('## Invariants');
  });

  it('gives every logical stream kind exactly one manifest owner matching its catalogue', async () => {
    await expect(checker.checkModuleManifests()).resolves.toEqual([]);
  });

  it('accepts the extracted Eventing workspace package as a module dependency', async () => {
    const root = await manifestFixture({
      bootstrap: {
        dependencies: ['eventing'],
        streams: [],
        source: "import type { EventJournal } from '@atolis-hq/eventing';",
      },
    });

    await expect(checker.checkModuleManifests(root)).resolves.toEqual([]);
  });

  it('requires modules importing Eventing to declare the logical dependency', async () => {
    const root = await manifestFixture({
      work: {
        dependencies: [],
        streams: [],
        source:
          "import type { EventData } from '@atolis-hq/eventing';\nexport type WorkEvent = EventData;",
      },
    });

    await expect(checker.checkModuleManifests(root)).resolves.toContain(
      'work: imports @atolis-hq/eventing but does not declare dependency eventing',
    );
  });

  it('allows only Bootstrap to import the filesystem adapter package', async () => {
    const root = await manifestFixture({
      work: {
        dependencies: ['eventing-filesystem'],
        streams: [],
        source:
          "import { FileEventJournal } from '@atolis-hq/eventing-filesystem';\nexport { FileEventJournal };",
      },
    });

    await expect(checker.checkModuleManifests(root)).resolves.toContain(
      'work: imports @atolis-hq/eventing-filesystem but only bootstrap may compose filesystem adapters',
    );
  });

  it('allows Bootstrap to import the public filesystem adapter package entry', async () => {
    const root = await manifestFixture({
      bootstrap: {
        dependencies: ['eventing-filesystem'],
        streams: [],
        source:
          "import { FileEventJournal as Journal } from '@atolis-hq/eventing-filesystem';\nexport { Journal };",
      },
    });

    await expect(checker.checkModuleManifests(root)).resolves.toEqual([]);
  });

  it('rejects Eventing and filesystem package boundary escapes and package-internal Wake imports', async () => {
    const root = await workspaceBoundaryFixture({
      'src/bootstrap/index.ts': [
        "import { FileEventJournal as Journal } from '@atolis-hq/eventing-filesystem';",
        'export { Journal };',
      ].join('\n'),
      'src/bootstrap/module.json': manifest('bootstrap', ['eventing-filesystem']),
      'src/work/internal-imports.ts': [
        "import type { EventEnvelope as Envelope } from '@atolis-hq/eventing/contracts/events.js';",
        "import * as Filesystem from '@atolis-hq/eventing-filesystem/src/index.js';",
        "export type { EventEnvelope as ReExportedEnvelope } from '@atolis-hq/eventing/dist/contracts/events.js';",
        'const { FileEventJournal } = Filesystem;',
        'const [tupleEntry] = [FileEventJournal];',
        'export type TupleEntry = typeof tupleEntry;',
        'export type PublicEnvelope = Envelope;',
      ].join('\n'),
      'src/work/module.json': manifest('work', ['eventing']),
      'packages/eventing/src/illegal-filesystem.ts':
        "import { readFile } from 'node:fs/promises';\nexport { readFile };",
      'packages/eventing/src/illegal-wake-import.ts':
        "export { SystemClock } from '../../../src/kernel/index.js';",
      'packages/eventing-filesystem/src/illegal-wake-import.ts':
        "export { SystemClock } from '../../../src/kernel/index.js';",
    });

    await expect(checker.checkModuleManifests(join(root, 'src'))).resolves.toEqual(
      expect.arrayContaining([
        'illegal-filesystem.ts: imports node:fs/promises; eventing may depend only on package dependencies and local files',
        'illegal-wake-import.ts: imports ../../../src/kernel/index.js; eventing may depend only on package dependencies and local files',
        'illegal-wake-import.ts: imports ../../../src/kernel/index.js; eventing-filesystem may depend only on @atolis-hq/eventing, Node builtins, and local files',
        'work/internal-imports.ts: imports package-internal path @atolis-hq/eventing/contracts/events.js; import only a declared public package entry',
        'work/internal-imports.ts: imports package-internal path @atolis-hq/eventing-filesystem/src/index.js; import only a declared public package entry',
        'work/internal-imports.ts: imports package-internal path @atolis-hq/eventing/dist/contracts/events.js; import only a declared public package entry',
      ]),
    );
  });

  it('enforces literal dynamic and CommonJS package imports without rejecting package-local imports', async () => {
    const root = await workspaceBoundaryFixture({
      'src/bootstrap/index.ts': [
        "export const loadFilesystem = () => import('@atolis-hq/eventing-filesystem');",
      ].join('\n'),
      'src/bootstrap/module.json': manifest('bootstrap', ['eventing-filesystem']),
      'src/work/dynamic-imports.ts': [
        "export const loadPrivateEventing = () => import('@atolis-hq/eventing/contracts/events.js');",
        'export const loadTemplatePrivateEventing = () => import(`@atolis-hq/eventing/dist/contracts/events.js`);',
        "export const loadFilesystem = () => import('@atolis-hq/eventing-filesystem');",
        "export const loadPrivateFilesystem = () => require('@atolis-hq/eventing-filesystem/src/index.js');",
      ].join('\n'),
      'src/work/create-require-imports.ts': [
        "import { createRequire } from 'node:module';",
        'const packageRequire = createRequire(import.meta.url);',
        "export const privateEventing = packageRequire('@atolis-hq/eventing/contracts/events.js');",
        "export const privateEventingDirect = createRequire(import.meta.url)('@atolis-hq/eventing/dist/contracts/events.js');",
      ].join('\n'),
      'src/work/shadowed-create-require.ts': [
        "import { createRequire as createModuleRequire } from 'node:module';",
        'const packageRequire = createModuleRequire(import.meta.url);',
        "export const loadFromParameter = (packageRequire: (target: string) => unknown) => packageRequire('@atolis-hq/eventing/contracts/events.js');",
        'export function loadFromLocal() {',
        '  const packageRequire = (target: string) => target;',
        "  return packageRequire('@atolis-hq/eventing/contracts/events.js');",
        '}',
      ].join('\n'),
      'src/work/nested-create-require.ts': [
        "import { createRequire as createModuleRequire } from 'node:module';",
        'const eventingRequire = createModuleRequire(import.meta.url);',
        'const filesystemRequire = createModuleRequire(import.meta.url);',
        "export const loadPrivateEventing = () => eventingRequire('@atolis-hq/eventing/contracts/events.js');",
        "export function loadPrivateFilesystem() { return filesystemRequire('@atolis-hq/eventing-filesystem/src/index.js'); }",
        "export const loadPrivateDirect = () => createModuleRequire(import.meta.url)('@atolis-hq/eventing/dist/contracts/events.js');",
      ].join('\n'),
      'src/work/shadowed-direct-require.ts': [
        "export const loadUnknown = (require: (target: string) => unknown) => require('@atolis-hq/eventing/contracts/events.js');",
      ].join('\n'),
      'src/work/local-direct-require.ts': [
        'export function loadUnknown() {',
        '  const require = (target: string) => target;',
        "  return require('@atolis-hq/eventing/contracts/events.js');",
        '}',
      ].join('\n'),
      'src/work/method-named-require.ts': [
        'export class Loader {',
        '  require() {',
        "    return require('@atolis-hq/eventing/contracts/events.js');",
        '  }',
        '}',
      ].join('\n'),
      'src/work/nonliteral-dynamic-imports.ts': [
        "const target = '@atolis-hq/eventing/contracts/events.js';",
        'export const loadUnknown = () => import(target);',
        'export const requireUnknown = () => require(target);',
      ].join('\n'),
      'src/work/local-create-require.ts': [
        'const createRequire = () => (target: string) => target;',
        "export const loadUnknown = () => createRequire()('@atolis-hq/eventing/contracts/events.js');",
      ].join('\n'),
      'src/work/module.json': manifest('work', ['eventing', 'eventing-filesystem']),
      'packages/eventing/src/illegal-dynamic-wake-import.ts':
        "export const loadKernel = () => import('../../../src/kernel/index.js');",
      'packages/eventing-filesystem/src/illegal-require-wake-import.ts':
        "export const loadKernel = () => require('../../../src/kernel/index.js');",
      'packages/eventing/src/local.ts': 'export const local = true;',
      'packages/eventing/src/allowed-dynamic-local.ts':
        "export const loadLocal = () => import('./local.js');",
    });

    const failures = await checker.checkModuleManifests(join(root, 'src'));

    expect(failures).toEqual(
      expect.arrayContaining([
        'work/dynamic-imports.ts: imports package-internal path @atolis-hq/eventing/contracts/events.js; import only a declared public package entry',
        'work/dynamic-imports.ts: imports package-internal path @atolis-hq/eventing/dist/contracts/events.js; import only a declared public package entry',
        'work: imports @atolis-hq/eventing-filesystem but only bootstrap may compose filesystem adapters',
        'work/dynamic-imports.ts: imports package-internal path @atolis-hq/eventing-filesystem/src/index.js; import only a declared public package entry',
        'work/create-require-imports.ts: imports package-internal path @atolis-hq/eventing/contracts/events.js; import only a declared public package entry',
        'work/create-require-imports.ts: imports package-internal path @atolis-hq/eventing/dist/contracts/events.js; import only a declared public package entry',
        'work/nested-create-require.ts: imports package-internal path @atolis-hq/eventing/contracts/events.js; import only a declared public package entry',
        'work/nested-create-require.ts: imports package-internal path @atolis-hq/eventing-filesystem/src/index.js; import only a declared public package entry',
        'work/nested-create-require.ts: imports package-internal path @atolis-hq/eventing/dist/contracts/events.js; import only a declared public package entry',
        'work/method-named-require.ts: imports package-internal path @atolis-hq/eventing/contracts/events.js; import only a declared public package entry',
        'illegal-dynamic-wake-import.ts: imports ../../../src/kernel/index.js; eventing may depend only on package dependencies and local files',
        'illegal-require-wake-import.ts: imports ../../../src/kernel/index.js; eventing-filesystem may depend only on @atolis-hq/eventing, Node builtins, and local files',
      ]),
    );
    for (const path of [
      'work/nonliteral-dynamic-imports.ts',
      'work/local-create-require.ts',
      'work/shadowed-create-require.ts',
      'work/shadowed-direct-require.ts',
      'work/local-direct-require.ts',
    ]) {
      expect(failures).not.toEqual(expect.arrayContaining([expect.stringContaining(path)]));
    }
  });

  it('rejects filesystem package source imports outside Eventing and Node', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-eventing-filesystem-'));
    fixtureRoots.push(root);
    await writeFixture(
      join(root, 'index.ts'),
      "import { SystemClock } from '../../../src/kernel/index.js';\nexport { SystemClock };",
    );

    await expect(checker.checkEventingFilesystemPackage(root)).resolves.toContain(
      'index.ts: imports ../../../src/kernel/index.js; eventing-filesystem may depend only on @atolis-hq/eventing, Node builtins, and local files',
    );
  });

  it('rejects duplicate stream ownership', async () => {
    const root = await manifestFixture({
      work: {
        streams: ['work-item'],
        source: "export const WorkStreamKind = { WorkItem: 'work-item' } as const;",
      },
      resources: {
        streams: ['work-item'],
        source: "export const ResourceStreamKind = { Resource: 'work-item' } as const;",
      },
    });

    await expect(checker.checkModuleManifests(root)).resolves.toContain(
      'stream kind work-item has duplicate manifest owners: resources, work',
    );
  });

  it('rejects a stream catalogue declared outside its manifest owner', async () => {
    const root = await manifestFixture({
      work: {
        streams: [],
        source: "export const WorkStreamKind = { WorkItem: 'work-item' } as const;",
      },
    });

    await expect(checker.checkModuleManifests(root)).resolves.toContain(
      'work: stream catalogue value work-item is not declared in its manifest',
    );
  });

  it('rejects a stream catalogue exported outside contracts/streams.ts', async () => {
    const root = await manifestFixture({
      work: {
        streams: ['work-item'],
        sourcePath: 'application/stream-values.ts',
        source: "export const WorkStreamKind = { WorkItem: 'work-item' } as const;",
      },
    });

    await expect(checker.checkModuleManifests(root)).resolves.toContain(
      'work/application/stream-values.ts:1:14 [stream-literals] WorkStreamKind must be declared in contracts/streams.ts',
    );
  });

  it('rejects a nested contracts/streams.ts as a module stream catalogue', async () => {
    const root = await manifestFixture({
      work: {
        streams: ['work-item'],
        sourcePath: 'application/contracts/streams.ts',
        source: "export const WorkStreamKind = { WorkItem: 'work-item' } as const;",
      },
    });

    await expect(checker.checkModuleManifests(root)).resolves.toContain(
      'work/application/contracts/streams.ts:1:14 [stream-literals] WorkStreamKind must be declared in contracts/streams.ts',
    );
  });
});

describe('module manifest catalogue integrity', () => {
  it('rejects multiple StreamKind catalogues in the canonical file', async () => {
    const root = await manifestFixture({
      work: {
        streams: ['work-item', 'legacy'],
        source: [
          "export const WorkStreamKind = { WorkItem: 'work-item' } as const;",
          "export const LegacyStreamKind = { Legacy: 'legacy' } as const;",
        ].join('\n'),
      },
    });

    await expect(checker.checkModuleManifests(root)).resolves.toContain(
      'work/contracts/streams.ts:2:14 [stream-literals] LegacyStreamKind duplicates WorkStreamKind; contracts/streams.ts must declare exactly one StreamKind catalogue',
    );
  });

  it('rejects duplicate stream registrations from one catalogue owner', async () => {
    const root = await manifestFixture({
      work: {
        streams: ['work-item'],
        source:
          "export const WorkStreamKind = { WorkItem: 'work-item', Alias: 'work-item' } as const;",
      },
    });

    await expect(checker.checkModuleManifests(root)).resolves.toContain(
      'stream kind work-item has duplicate catalogue owners: work, work',
    );
  });

  it('rejects nested delivery events outside the manifest event namespace', async () => {
    const root = await manifestFixture({
      integrations: {
        streams: ['delivery'],
        events: ['integration.'],
        source: "export const IntegrationStreamKind = { Delivery: 'delivery' } as const;",
        eventSourcePath: 'delivery/contracts/events.ts',
        eventSource:
          "export const DeliveryEventType = { Confirmed: 'delivery.confirmed' } as const;",
      },
    });

    await expect(checker.checkModuleManifests(root)).resolves.toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^integrations\/delivery\/contracts\/events\.ts:\d+:\d+ \[event-literals\] delivery\.confirmed is not declared in integrations module manifest events$/,
        ),
      ]),
    );
  });

  it('rejects nested delivery intent events outside the manifest event namespaces', async () => {
    const root = await manifestFixture({
      integrations: {
        streams: ['delivery'],
        events: ['integration.', 'delivery.'],
        source: "export const IntegrationStreamKind = { Delivery: 'delivery' } as const;",
        eventSourcePath: 'delivery/contracts/intents.ts',
        eventSource: [
          'export const DeliveryIntentEventType = {',
          "  StatusPublishRequested: 'status.publish-requested',",
          "  ReplyPublishRequested: 'reply.publish-requested',",
          '} as const;',
        ].join('\n'),
      },
    });

    await expect(checker.checkModuleManifests(root)).resolves.toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^integrations\/delivery\/contracts\/intents\.ts:\d+:\d+ \[event-literals\] status\.publish-requested is not declared in integrations module manifest events$/,
        ),
        expect.stringMatching(
          /^integrations\/delivery\/contracts\/intents\.ts:\d+:\d+ \[event-literals\] reply\.publish-requested is not declared in integrations module manifest events$/,
        ),
      ]),
    );
  });
});

async function manifestFixture(
  fixtures: Readonly<
    Record<
      string,
      {
        readonly dependencies?: readonly string[];
        readonly streams: readonly string[];
        readonly events?: readonly string[];
        readonly source: string;
        readonly sourcePath?: string;
        readonly eventSource?: string;
        readonly eventSourcePath?: string;
      }
    >
  >,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wake-module-manifests-'));
  fixtureRoots.push(root);
  await Promise.all(
    Object.entries(fixtures).flatMap(([name, fixture]) => {
      const manifestPath = join(root, name, 'module.json');
      const streamsPath = join(root, name, fixture.sourcePath ?? 'contracts/streams.ts');
      const manifest = {
        name,
        kind: 'domain',
        dependencies: fixture.dependencies ?? [],
        publicEntry: './index.ts',
        namespaces: {
          events: fixture.events ?? [],
          config: [],
          relations: [],
          streams: fixture.streams,
        },
      };
      const files = [
        writeFixture(manifestPath, `${JSON.stringify(manifest)}\n`),
        writeFixture(streamsPath, fixture.source),
      ];
      if (fixture.eventSource !== undefined) {
        files.push(
          writeFixture(
            join(root, name, fixture.eventSourcePath ?? 'contracts/events.ts'),
            fixture.eventSource,
          ),
        );
      }
      return files;
    }),
  );
  return root;
}

async function workspaceBoundaryFixture(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wake-workspace-boundaries-'));
  fixtureRoots.push(root);
  await Promise.all(
    Object.entries(files).map(([path, source]) => writeFixture(join(root, path), source)),
  );
  return root;
}

function manifest(name: string, dependencies: readonly string[]): string {
  return `${JSON.stringify({
    name,
    kind: 'domain',
    dependencies,
    publicEntry: './index.ts',
    namespaces: { events: [], config: [], relations: [], streams: [] },
  })}\n`;
}

async function writeFixture(path: string, source: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, source, 'utf8');
}
