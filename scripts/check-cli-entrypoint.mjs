import { readFile } from 'node:fs/promises';

const entrypoint = await readFile('dist/src/main.js', 'utf8');

if (!entrypoint.startsWith('#!/usr/bin/env node\n')) {
  throw new Error('The compiled Wake CLI entrypoint must declare Node as its interpreter.');
}
