import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AssetSource, SurfaceAsset } from './asset-source.js';

const contentTypeFor = (path: string) =>
  path.endsWith('.js')
    ? 'text/javascript; charset=utf-8'
    : path.endsWith('.css')
      ? 'text/css; charset=utf-8'
      : 'application/octet-stream';

export class PackagedAssets implements AssetSource {
  constructor(private readonly read: (path: string) => Promise<Uint8Array | undefined>) {}

  async get(path: string): Promise<SurfaceAsset | undefined> {
    const normalized = path.replace(/^\/+/, '');
    const body = await this.read(normalized);
    if (body === undefined) return undefined;
    const immutable = /[.-][a-z0-9]{4,}\.(?:js|css)$/i.test(normalized);
    return {
      body,
      contentType: contentTypeFor(normalized),
      headers: { 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' },
    };
  }
}

export function packagedWebAssetsRoot(moduleUrl = import.meta.url): string {
  return fileURLToPath(new URL('../web-assets/', moduleUrl)).replace(/[\\/]$/, '');
}

export function createPackagedAssetSource(moduleUrl = import.meta.url): PackagedAssets {
  const root = packagedWebAssetsRoot(moduleUrl);
  return new PackagedAssets(async (path) => {
    if (path.split(/[\\/]/).includes('..')) return undefined;
    try {
      return await readFile(join(root, path));
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : Promise.reject(error);
    }
  });
}
