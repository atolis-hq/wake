import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const modules = [
  'kernel',
  'persistence',
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
const checkerModulePath = '../../scripts/check-module-manifests.mjs';
const checker = (await import(checkerModulePath)) as {
  readonly checkModuleManifests: CheckModuleManifests;
};
const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('module manifests', () => {
  it.each(modules)('%s has matching human and machine contracts', async (name) => {
    const manifest = JSON.parse(
      await readFile(`src-next/${name}/module.json`, 'utf8'),
    ) as ModuleManifest;
    const moduleDoc = await readFile(`src-next/${name}/MODULE.md`, 'utf8');
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
});

async function manifestFixture(
  fixtures: Readonly<
    Record<
      string,
      {
        readonly streams: readonly string[];
        readonly source: string;
        readonly sourcePath?: string;
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
        dependencies: [],
        publicEntry: './index.ts',
        namespaces: { events: [], config: [], relations: [], streams: fixture.streams },
      };
      return [
        writeFixture(manifestPath, `${JSON.stringify(manifest)}\n`),
        writeFixture(streamsPath, fixture.source),
      ];
    }),
  );
  return root;
}

async function writeFixture(path: string, source: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, source, 'utf8');
}
