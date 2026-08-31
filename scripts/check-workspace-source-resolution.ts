import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const packagesDirectory = join(repoRoot, 'packages');
let packageCount = 0;

for (const entry of readdirSync(packagesDirectory, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const packageDirectory = join(packagesDirectory, entry.name);
  const sourceEntry = join(packageDirectory, 'src/index.ts');
  if (!existsSync(sourceEntry)) continue;
  const manifest = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8')) as {
    readonly name: string;
  };
  const resolvedEntry = fileURLToPath(import.meta.resolve(manifest.name));
  if (resolve(resolvedEntry) !== resolve(sourceEntry)) {
    throw new Error(`${manifest.name} resolved to ${resolvedEntry}; expected ${sourceEntry}`);
  }
  await import(manifest.name);
  packageCount += 1;
}

const memoryEntry = join(repoRoot, 'packages', 'eventing', 'src', 'memory.ts');
const resolvedMemoryEntry = fileURLToPath(import.meta.resolve('@atolis-hq/eventing/memory'));
if (resolve(resolvedMemoryEntry) !== resolve(memoryEntry)) {
  throw new Error(
    `@atolis-hq/eventing/memory resolved to ${resolvedMemoryEntry}; expected ${memoryEntry}`,
  );
}
const memory = await import('@atolis-hq/eventing/memory');
if (typeof memory.InMemoryEventJournal !== 'function') {
  throw new Error('@atolis-hq/eventing/memory did not export InMemoryEventJournal');
}

const { main } = await import('../src/main.js');
if (typeof main !== 'function') throw new Error('Wake source entry did not export main');

process.stdout.write(`Workspace source resolution valid: ${packageCount} package(s)\n`);
