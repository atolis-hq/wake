import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

type PackageManifest = {
  readonly dependencies?: Record<string, string>;
  readonly exports?: Record<string, unknown>;
  readonly files?: readonly string[];
  readonly name: string;
  readonly private?: boolean;
  readonly publishConfig?: { readonly access?: string };
  readonly scripts?: Record<string, string>;
  readonly version: string;
  readonly workspaces?: readonly string[];
};

type TsConfig = {
  readonly compilerOptions?: {
    readonly noEmit?: boolean;
    readonly paths?: Record<string, readonly string[]>;
  };
  readonly include?: readonly string[];
  readonly references?: readonly { readonly path: string }[];
};

type PackageLock = {
  readonly packages: Record<
    string,
    {
      readonly link?: boolean;
      readonly resolved?: string;
      readonly dependencies?: Record<string, string>;
    }
  >;
};

interface WorkspacePackageConfiguration {
  readonly appTsConfig: TsConfig;
  readonly eventing: PackageManifest;
  readonly eventingTestTsConfig: TsConfig;
  readonly filesystem: PackageManifest;
  readonly filesystemTestTsConfig: TsConfig;
  readonly filesystemTsConfig: TsConfig;
  readonly lockfile: PackageLock;
  readonly rootTsConfig: TsConfig;
  readonly sourceTsConfig: TsConfig;
  readonly wake: PackageManifest;
}

const readJson = async <Value>(path: string): Promise<Value> =>
  JSON.parse(await readFile(new URL(`../../${path}`, import.meta.url), 'utf8')) as Value;

function expectEventingSourcePaths(sourceTsConfig: TsConfig): void {
  expect(sourceTsConfig.compilerOptions?.paths?.['@atolis-hq/eventing']).toEqual([
    './packages/eventing/src/index.ts',
  ]);
  expect(sourceTsConfig.compilerOptions?.paths?.['@atolis-hq/eventing/memory']).toEqual([
    './packages/eventing/src/memory.ts',
  ]);
  expect(sourceTsConfig.compilerOptions?.paths?.['@atolis-hq/eventing-filesystem']).toEqual([
    './packages/eventing-filesystem/src/index.ts',
  ]);
}

async function readWorkspacePackageConfiguration(): Promise<WorkspacePackageConfiguration> {
  const [
    wake,
    eventing,
    filesystem,
    rootTsConfig,
    appTsConfig,
    filesystemTsConfig,
    eventingTestTsConfig,
    filesystemTestTsConfig,
    sourceTsConfig,
    lockfile,
  ] = await Promise.all([
    readJson<PackageManifest>('package.json'),
    readJson<PackageManifest>('packages/eventing/package.json'),
    readJson<PackageManifest>('packages/eventing-filesystem/package.json'),
    readJson<TsConfig>('tsconfig.json'),
    readJson<TsConfig>('tsconfig.app.json'),
    readJson<TsConfig>('packages/eventing-filesystem/tsconfig.json'),
    readJson<TsConfig>('packages/eventing/tsconfig.test.json'),
    readJson<TsConfig>('packages/eventing-filesystem/tsconfig.test.json'),
    readJson<TsConfig>('tsconfig.source.json'),
    readJson<PackageLock>('package-lock.json'),
  ]);
  return {
    appTsConfig,
    eventing,
    eventingTestTsConfig,
    filesystem,
    filesystemTestTsConfig,
    filesystemTsConfig,
    lockfile,
    rootTsConfig,
    sourceTsConfig,
    wake,
  };
}

function expectEmbeddedRuntimePackageManifests({
  eventing,
  filesystem,
  wake,
}: WorkspacePackageConfiguration): void {
  expect(wake.workspaces).toEqual(expect.arrayContaining(['packages/*', 'src/surfaces/web']));
  expect(eventing).toMatchObject({
    name: '@atolis-hq/eventing',
    version: '0.1.0',
    private: true,
  });
  expect(filesystem).toMatchObject({
    name: '@atolis-hq/eventing-filesystem',
    version: '0.1.0',
    private: true,
  });
  expect(eventing.publishConfig).toBeUndefined();
  expect(filesystem.publishConfig).toBeUndefined();
  expect(eventing.files).toEqual(expect.arrayContaining(['dist', 'README.md', 'LICENSE']));
  expect(filesystem.files).toEqual(expect.arrayContaining(['dist', 'README.md', 'LICENSE']));
  expect(eventing.exports).toHaveProperty('./memory');
  expect(filesystem.exports).toHaveProperty('.');
}

function expectEventingBuildScripts(eventing: PackageManifest): void {
  expect(eventing.scripts?.clean).toBe('node scripts/clean-dist.mjs');
  expect(eventing.scripts?.build).toBe('npm run clean && tsc --build --force tsconfig.json');
  expect(eventing.scripts?.prepack).toBe('npm run build');
  expect(eventing.scripts?.['typecheck:test']).toBe('tsc --noEmit --project tsconfig.test.json');
  expect(eventing.scripts?.test).toBe(
    'npm run typecheck:test && vitest run --config vitest.config.ts',
  );
}

function expectFilesystemBuildScripts(
  eventing: PackageManifest,
  filesystem: PackageManifest,
): void {
  expect(filesystem.scripts?.clean).toBe('node scripts/clean-dist.mjs');
  expect(filesystem.scripts?.build).toBe('npm run clean && tsc --build --force tsconfig.json');
  expect(filesystem.scripts?.prepack).toBe('npm run build');
  expect(filesystem.dependencies?.['@atolis-hq/eventing']).toBe(eventing.version);
}

function expectWakeEmbeddedRuntimeBuildScripts(wake: PackageManifest): void {
  expect(wake.dependencies?.['@atolis-hq/eventing']).toBeUndefined();
  expect(wake.dependencies?.['@atolis-hq/eventing-filesystem']).toBeUndefined();
  expect(wake.scripts?.build).toContain('node scripts/embed-runtime-workspaces.mjs');
  expect(wake.scripts?.['build:docker']).toContain('node scripts/embed-runtime-workspaces.mjs');
}

function expectWorkspaceProjectReferences({
  appTsConfig,
  eventingTestTsConfig,
  filesystemTestTsConfig,
  filesystemTsConfig,
  rootTsConfig,
  sourceTsConfig,
}: WorkspacePackageConfiguration): void {
  expect(rootTsConfig.references).toEqual([
    { path: './packages/eventing' },
    { path: './packages/eventing-filesystem' },
    { path: './tsconfig.app.json' },
  ]);
  expect(appTsConfig.references).toEqual([
    { path: './packages/eventing' },
    { path: './packages/eventing-filesystem' },
  ]);
  expect(filesystemTsConfig.references).toEqual([{ path: '../eventing' }]);
  expect(filesystemTsConfig.include).toEqual(['src/**/*.ts']);
  expect(eventingTestTsConfig.compilerOptions?.noEmit).toBe(true);
  expect(eventingTestTsConfig.include).toEqual(['src/**/*.ts', 'test/**/*.ts']);
  expect(filesystemTestTsConfig.compilerOptions?.noEmit).toBe(true);
  expect(filesystemTestTsConfig.include).toEqual(['src/**/*.ts', 'test/**/*.ts']);
  expectEventingSourcePaths(sourceTsConfig);
}

function expectWorkspacePackageLinks({ lockfile }: WorkspacePackageConfiguration): void {
  expect(lockfile.packages['node_modules/@atolis-hq/eventing']).toEqual({
    resolved: 'packages/eventing',
    link: true,
  });
  expect(lockfile.packages['node_modules/@atolis-hq/eventing-filesystem']).toEqual({
    resolved: 'packages/eventing-filesystem',
    link: true,
  });
}

describe('eventing workspace packages', () => {
  it('keeps Eventing private while embedding its built runtime in Wake', async () => {
    expect.hasAssertions();
    const configuration = await readWorkspacePackageConfiguration();
    expectEmbeddedRuntimePackageManifests(configuration);
    expectEventingBuildScripts(configuration.eventing);
    expectFilesystemBuildScripts(configuration.eventing, configuration.filesystem);
    expectWakeEmbeddedRuntimeBuildScripts(configuration.wake);
    expectWorkspaceProjectReferences(configuration);
    expectWorkspacePackageLinks(configuration);
  });

  it('builds the Docker application through Eventing project references', async () => {
    const [wake, dockerTsConfig] = await Promise.all([
      readJson<PackageManifest>('package.json'),
      readJson<TsConfig>('tsconfig.docker.json'),
    ]);

    expect(dockerTsConfig.references).toEqual([
      { path: './packages/eventing' },
      { path: './packages/eventing-filesystem' },
    ]);
    expect(wake.scripts?.['build:docker']).toContain('tsc --build tsconfig.docker.json');
  });

  it('keeps published exports on dist while source tools use workspace aliases', async () => {
    const [eventing, aliases, sourceResolutionCheck, configs] = await Promise.all([
      readJson<PackageManifest>('packages/eventing/package.json'),
      readFile(new URL('../../vitest.workspace-aliases.ts', import.meta.url), 'utf8'),
      readFile(
        new URL('../../scripts/check-workspace-source-resolution.ts', import.meta.url),
        'utf8',
      ),
      Promise.all(
        [
          'vitest.unit.config.ts',
          'vitest.architecture.config.ts',
          'vitest.integration.config.ts',
          'vitest.e2e.config.ts',
          'vitest.live-e2e.config.ts',
        ].map((path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8')),
      ),
    ]);

    expect(eventing.exports).toEqual({
      '.': {
        types: './dist/index.d.ts',
        default: './dist/index.js',
      },
      './memory': {
        types: './dist/memory.d.ts',
        default: './dist/memory.js',
      },
    });
    expect(aliases).toContain("'./packages'");
    expect(aliases).toContain("'src/index.ts'");
    expect(sourceResolutionCheck).toContain('import.meta.resolve(manifest.name)');
    expect(sourceResolutionCheck).toContain("import('@atolis-hq/eventing/memory')");
    for (const config of configs) expect(config).toContain('workspaceSourceAliases');
  });

  it('prepares the embedded runtime before running clean-checkout tools', async () => {
    const [launcher, wake, webVitestConfig, packageCheck, knipConfig] = await Promise.all([
      readFile(new URL('../../bin/wake-dev.js', import.meta.url), 'utf8'),
      readJson<PackageManifest>('package.json'),
      readFile(new URL('../../src/surfaces/web/vitest.config.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../scripts/check-workspace-packages.mjs', import.meta.url), 'utf8'),
      readFile(new URL('../../knip.json', import.meta.url), 'utf8'),
    ]);

    expect(launcher).toContain("'--tsconfig', sourceTsConfig");
    expect(wake.scripts?.['build:eventing-packages']).toBe(
      'tsc --build packages/eventing-filesystem/tsconfig.json',
    );
    expect(wake.scripts?.['build:web']).toContain('npm run build:eventing-packages');
    expect(wake.scripts?.['test:web']).toContain('npm run build:eventing-packages');
    expect(webVitestConfig).toContain('maxWorkers: 4');
    expect(packageCheck).toContain(
      "const packageLocations = [{ directory: repoRoot, label: 'Wake' }];",
    );
    expect(packageCheck).toContain("['install', '--ignore-scripts', '--no-audit', '--no-fund']");
    expect(packageCheck).not.toContain('packages/eventing');
    expect(packageCheck).not.toContain('packages/eventing-filesystem');
    expect(packageCheck).toContain("['exec', '--offline', '--', 'wake', '--help']");
    expect(wake.scripts?.['check:workspace-packages']).toBe(
      'node scripts/check-workspace-packages.mjs',
    );
    expect(packageCheck).toContain("const requiredArchiveFiles = ['README.md', 'LICENSE'];");
    expect(packageCheck).toContain(
      "const embeddedRuntimePackages = ['eventing', 'eventing-filesystem'];",
    );
    expect(packageCheck).toContain(
      "const requiredEmbeddedRuntimeFiles = ['package.json', 'README.md', 'LICENSE'];",
    );
    expect(packageCheck).toContain('if (!entry.isDirectory() || entry.isSymbolicLink())');
    expect(packageCheck).toContain('archive is missing required package file');
    expect(knipConfig).toContain(
      '"ignoreDependencies": ["@atolis-hq/eventing", "@atolis-hq/eventing-filesystem"]',
    );
  });
});
