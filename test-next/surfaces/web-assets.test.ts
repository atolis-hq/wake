import { describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import {
  PackagedAssets,
  packagedWebAssetsRoot,
} from '../../src-next/surfaces/web-host/packaged-assets.js';

describe('packaged web assets', () => {
  it('serves immutable hashed assets from its packaged source without a Wake-home write', async () => {
    const assets = new PackagedAssets(async (path) =>
      path === 'assets/app-a1b2.js' ? new Uint8Array([1, 2]) : undefined,
    );
    const response = await assets.get('/assets/app-a1b2.js');
    expect(response?.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(response?.body).toEqual(new Uint8Array([1, 2]));
  });

  it('resolves production assets adjacent to the compiled Surface host', () => {
    const compiledHost = pathToFileURL(
      resolve('package', 'dist-next', 'src-next', 'surfaces', 'web-host', 'packaged-assets.js'),
    ).href;
    expect(packagedWebAssetsRoot(compiledHost)).toBe(
      resolve('package', 'dist-next', 'src-next', 'surfaces', 'web-assets'),
    );
  });
});
