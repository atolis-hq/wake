import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

type PackageManifest = {
  readonly dependencies?: Record<string, string>;
  readonly files?: readonly string[];
  readonly name: string;
  readonly publishConfig?: { readonly access?: string };
  readonly version: string;
  readonly workspaces?: readonly string[];
};

const readManifest = async (path: string): Promise<PackageManifest> =>
  JSON.parse(await readFile(new URL(`../../${path}`, import.meta.url), 'utf8')) as PackageManifest;

describe('eventing workspace packages', () => {
  it('declares public, exact-versioned eventing package relationships', async () => {
    const [wake, eventing, filesystem] = await Promise.all([
      readManifest('package.json'),
      readManifest('packages/eventing/package.json'),
      readManifest('packages/eventing-filesystem/package.json'),
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
    expect(filesystem.dependencies?.['@atolis-hq/eventing']).toBe(eventing.version);
    expect(wake.dependencies?.['@atolis-hq/eventing']).toBe(eventing.version);
    expect(wake.dependencies?.['@atolis-hq/eventing-filesystem']).toBe(filesystem.version);
  });
});
