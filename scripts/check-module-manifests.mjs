import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const root = 'src-next';
const modules = (await readdir(root, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const manifests = new Map();
const failures = [];

for (const name of modules) {
  const path = join(root, name, 'module.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  manifests.set(name, manifest);
  if (manifest.name !== name) failures.push(`${path}: name must be ${name}`);
  if (manifest.publicEntry !== './index.ts')
    failures.push(`${path}: publicEntry must be ./index.ts`);
  if (!Array.isArray(manifest.dependencies))
    failures.push(`${path}: dependencies must be an array`);
}

for (const [name, manifest] of manifests) {
  for (const dependency of manifest.dependencies ?? []) {
    if (!manifests.has(dependency)) failures.push(`${name}: unknown dependency ${dependency}`);
    if (dependency === name) failures.push(`${name}: cannot depend on itself`);
  }
}

function visit(name, path = []) {
  if (path.includes(name)) {
    failures.push(`module cycle: ${[...path, name].join(' -> ')}`);
    return;
  }
  for (const dependency of manifests.get(name)?.dependencies ?? [])
    visit(dependency, [...path, name]);
}
for (const name of modules) visit(name);

if (failures.length > 0) {
  process.stderr.write(`${[...new Set(failures)].join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Module manifests valid: ${modules.length} modules\n`);
}
