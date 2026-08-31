import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

type PackageManifest = {
  readonly dependencies?: Record<string, string>;
  readonly exports?: Record<string, unknown>;
  readonly files?: readonly string[];
  readonly name: string;
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

describe('eventing workspace packages', () => {
  it('declares public, exact-versioned eventing package relationships', async () => {
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

    expect(wake.workspaces).toEqual(expect.arrayContaining(['packages/*', 'src/surfaces/web']));
    expect(eventing).toMatchObject({
      name: '@atolis-hq/eventing',
      version: '0.1.0',
      publishConfig: { access: 'public' },
    });
    expect(filesystem).toMatchObject({
      name: '@atolis-hq/eventing-filesystem',
      version: '0.1.0',
      publishConfig: { access: 'public' },
    });
    expect(eventing.files).toEqual(expect.arrayContaining(['dist', 'README.md', 'LICENSE']));
    expect(filesystem.files).toEqual(expect.arrayContaining(['dist', 'README.md', 'LICENSE']));
    expect(eventing.exports).toHaveProperty('./memory');
    expect(filesystem.exports).toHaveProperty('.');
    expect(eventing.scripts?.build).toBe('tsc --build tsconfig.json');
    expect(eventing.scripts?.['typecheck:test']).toBe('tsc --noEmit --project tsconfig.test.json');
    expect(eventing.scripts?.test).toBe(
      'npm run typecheck:test && vitest run --config vitest.config.ts',
    );
    expect(filesystem.scripts?.build).toBe('tsc --build tsconfig.json');
    expect(filesystem.dependencies?.['@atolis-hq/eventing']).toBe(eventing.version);
    expect(wake.dependencies?.['@atolis-hq/eventing']).toBe(eventing.version);
    expect(wake.dependencies?.['@atolis-hq/eventing-filesystem']).toBe(filesystem.version);
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
    expect(lockfile.packages['node_modules/@atolis-hq/eventing']).toEqual({
      resolved: 'packages/eventing',
      link: true,
    });
    expect(lockfile.packages['node_modules/@atolis-hq/eventing-filesystem']).toEqual({
      resolved: 'packages/eventing-filesystem',
      link: true,
    });
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
});
