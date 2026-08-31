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

describe('eventing workspace packages', () => {
  it('declares public, exact-versioned eventing package relationships', async () => {
    const [wake, eventing, filesystem, rootTsConfig, appTsConfig, filesystemTsConfig, lockfile] =
      await Promise.all([
        readJson<PackageManifest>('package.json'),
        readJson<PackageManifest>('packages/eventing/package.json'),
        readJson<PackageManifest>('packages/eventing-filesystem/package.json'),
        readJson<TsConfig>('tsconfig.json'),
        readJson<TsConfig>('tsconfig.app.json'),
        readJson<TsConfig>('packages/eventing-filesystem/tsconfig.json'),
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
    expect(eventing.exports).toHaveProperty('.');
    expect(eventing.exports).not.toHaveProperty('./memory');
    expect(filesystem.exports).toHaveProperty('.');
    expect(eventing.scripts?.build).toBe('tsc --build tsconfig.json');
    expect(eventing.scripts?.test).toBe('vitest run --config vitest.config.ts');
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
    expect(lockfile.packages['node_modules/@atolis-hq/eventing']).toEqual({
      resolved: 'packages/eventing',
      link: true,
    });
    expect(lockfile.packages['node_modules/@atolis-hq/eventing-filesystem']).toEqual({
      resolved: 'packages/eventing-filesystem',
      link: true,
    });
  });
});
