import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

import { discoverCatalogues } from './lib/contract-vocabulary-catalogues.mjs';

export async function checkModuleManifests(root = 'src-next') {
  const resolvedRoot = resolve(root);
  const modules = (await readdir(resolvedRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const manifests = new Map();
  const failures = [];

  for (const name of modules) {
    const path = join(resolvedRoot, name, 'module.json');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    manifests.set(name, manifest);
    if (manifest.name !== name) failures.push(`${relativePath(path)}: name must be ${name}`);
    if (manifest.publicEntry !== './index.ts')
      failures.push(`${relativePath(path)}: publicEntry must be ./index.ts`);
    if (!Array.isArray(manifest.dependencies))
      failures.push(`${relativePath(path)}: dependencies must be an array`);
    for (const namespace of ['events', 'config', 'relations', 'streams']) {
      if (!Array.isArray(manifest.namespaces?.[namespace])) {
        failures.push(`${relativePath(path)}: namespaces.${namespace} must be an array`);
      }
    }
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

  const manifestOwners = new Map();
  for (const [name, manifest] of manifests) {
    for (const stream of manifest.namespaces?.streams ?? []) {
      const owners = manifestOwners.get(stream) ?? [];
      owners.push(name);
      manifestOwners.set(stream, owners);
    }
  }
  for (const [stream, owners] of manifestOwners) {
    if (owners.length > 1) {
      failures.push(
        `stream kind ${stream} has duplicate manifest owners: ${[...owners].sort().join(', ')}`,
      );
    }
  }

  const sourceDetails = [];
  for (const path of await typescriptFiles(resolvedRoot)) {
    const text = await readFile(path, 'utf8');
    const cataloguePath = relative(resolvedRoot, path).split(sep).join('/');
    sourceDetails.push({
      path: cataloguePath,
      source: ts.createSourceFile(
        cataloguePath,
        text,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      ),
    });
  }

  const discovery = discoverCatalogues(sourceDetails, new Set(['stream-literals']));
  failures.push(...discovery.diagnostics.map(({ message }) => message));
  for (const [stream, registrations] of discovery.catalogues.streamValues) {
    const catalogueOwners = [
      ...new Set(registrations.map(({ path }) => path.split('/')[0])),
    ].sort();
    if (catalogueOwners.length > 1) {
      failures.push(
        `stream kind ${stream} has duplicate catalogue owners: ${catalogueOwners.join(', ')}`,
      );
    }
    for (const owner of catalogueOwners) {
      if (!(manifests.get(owner)?.namespaces?.streams ?? []).includes(stream)) {
        failures.push(`${owner}: stream catalogue value ${stream} is not declared in its manifest`);
      }
    }
  }
  for (const [name, manifest] of manifests) {
    for (const stream of manifest.namespaces?.streams ?? []) {
      const registrations = discovery.catalogues.streamValues.get(stream) ?? [];
      if (!registrations.some(({ path }) => path.split('/')[0] === name)) {
        failures.push(`${name}: manifest stream value ${stream} has no matching catalogue`);
      }
    }
  }

  return [...new Set(failures)];
}

function relativePath(path) {
  return relative(resolve('.'), path).split(sep).join('/');
}

async function typescriptFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await typescriptFiles(path)));
    if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path);
  }
  return files.sort();
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  const failures = await checkModuleManifests();
  if (failures.length > 0) {
    process.stderr.write(`${failures.join('\n')}\n`);
    process.exitCode = 1;
  } else {
    const moduleCount = (await readdir(resolve('src-next'), { withFileTypes: true })).filter(
      (entry) => entry.isDirectory(),
    ).length;
    process.stdout.write(`Module manifests valid: ${moduleCount} modules\n`);
  }
}
