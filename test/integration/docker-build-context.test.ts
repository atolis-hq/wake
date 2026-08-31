import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('source Docker build context', () => {
  it('includes only inputs copied by the source Dockerfile', async () => {
    const [ignore, dockerfile] = await Promise.all([
      readFile(join(process.cwd(), '.dockerignore'), 'utf8'),
      readFile(join(process.cwd(), 'docker/Dockerfile'), 'utf8'),
    ]);

    expect(ignore.split(/\r?\n/)).toEqual([
      '**',
      '!package.json',
      '!package-lock.json',
      '!tsconfig.json',
      '!tsconfig.base.json',
      '!tsconfig.app.json',
      '!tsconfig.docker.json',
      '!packages/',
      '!scripts/',
      '!assets/',
      '!src/',
      '',
    ]);
    expect(dockerfile).toContain(
      'COPY packages/eventing/package.json packages/eventing/package.json',
    );
    expect(dockerfile).toContain(
      'COPY packages/eventing-filesystem/package.json packages/eventing-filesystem/package.json',
    );
    expect(dockerfile).toContain(
      'COPY tsconfig.json tsconfig.base.json tsconfig.app.json tsconfig.docker.json ./',
    );
    expect(dockerfile).toContain('COPY packages/ packages/');
  });
});
