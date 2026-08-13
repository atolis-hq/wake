import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('source Docker build context', () => {
  it('includes only inputs copied by the source Dockerfile', async () => {
    const ignore = await readFile(join(process.cwd(), '.dockerignore'), 'utf8');

    expect(ignore.split(/\r?\n/)).toEqual([
      '**',
      '!package.json',
      '!package-lock.json',
      '!tsconfig.json',
      '!tsconfig.docker.json',
      '!scripts/',
      '!assets/',
      '!src/',
      '',
    ]);
  });
});
