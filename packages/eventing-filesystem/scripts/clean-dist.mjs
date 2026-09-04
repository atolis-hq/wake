import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

await Promise.all([
  rm(resolve(import.meta.dirname, '..', 'dist'), { force: true, recursive: true }),
  rm(resolve(import.meta.dirname, '..', 'tsconfig.tsbuildinfo'), { force: true }),
]);
