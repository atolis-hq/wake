import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('Wake CLI entrypoint', () => {
  it('declares Node as its interpreter before npm packages it', async () => {
    const entrypoint = await readFile('src/main.ts', 'utf8');

    expect(entrypoint.startsWith('#!/usr/bin/env node\n')).toBe(true);
  });
});
