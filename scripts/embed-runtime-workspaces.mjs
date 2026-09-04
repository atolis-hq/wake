#!/usr/bin/env node
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimePackages = ['eventing', 'eventing-filesystem'];
const packageFiles = ['package.json', 'README.md', 'LICENSE'];
const runtimeRoot = resolve(repoRoot, 'dist/src/node_modules/@atolis-hq');

async function requireFile(path) {
  try {
    const entry = await stat(path);
    if (entry.isFile()) return;
  } catch {
    // Report all source prerequisites consistently below.
  }
  throw new Error(`Embedded runtime source file is missing: ${path}`);
}

async function requireDirectory(path) {
  try {
    const entry = await stat(path);
    if (entry.isDirectory()) return;
  } catch {
    // Report all source prerequisites consistently below.
  }
  throw new Error(`Embedded runtime build output is missing: ${path}`);
}

async function embedRuntimePackage(packageName) {
  const source = resolve(repoRoot, 'packages', packageName);
  const destination = resolve(runtimeRoot, packageName);

  await Promise.all(packageFiles.map((file) => requireFile(resolve(source, file))));
  await requireDirectory(resolve(source, 'dist'));
  await mkdir(destination, { recursive: true });
  await Promise.all([
    ...packageFiles.map((file) => cp(resolve(source, file), resolve(destination, file))),
    cp(resolve(source, 'dist'), resolve(destination, 'dist'), { recursive: true }),
  ]);
}

await rm(runtimeRoot, { force: true, recursive: true });
await Promise.all(runtimePackages.map((packageName) => embedRuntimePackage(packageName)));
