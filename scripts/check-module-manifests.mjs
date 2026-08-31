import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

import { discoverCatalogues } from './lib/contract-vocabulary-catalogues.mjs';

const workspacePackages = [
  {
    name: '@atolis-hq/eventing',
    logicalDependency: 'eventing',
    publicEntries: new Set(['@atolis-hq/eventing', '@atolis-hq/eventing/memory']),
    sourceRoot: 'packages/eventing/src',
  },
  {
    name: '@atolis-hq/eventing-filesystem',
    logicalDependency: 'eventing-filesystem',
    publicEntries: new Set(['@atolis-hq/eventing-filesystem']),
    sourceRoot: 'packages/eventing-filesystem/src',
  },
];
const filesystemPackage = '@atolis-hq/eventing-filesystem';
const workspacePackageDependencies = new Map(
  workspacePackages.flatMap(({ logicalDependency, publicEntries }) =>
    [...publicEntries].map((entry) => [entry, logicalDependency]),
  ),
);
const workspaceLogicalDependencies = new Set(workspacePackageDependencies.values());

export async function checkModuleManifests(root = 'src') {
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
      if (!manifests.has(dependency) && !workspaceLogicalDependencies.has(dependency))
        failures.push(`${name}: unknown dependency ${dependency}`);
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
    const source = ts.createSourceFile(
      cataloguePath,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    sourceDetails.push({
      path: cataloguePath,
      source,
    });
    const owner = cataloguePath.split('/')[0];
    for (const packageName of importedModuleSpecifiers(source)) {
      const workspacePackage = workspacePackageForSpecifier(packageName);
      if (workspacePackage === undefined) continue;
      if (!workspacePackage.publicEntries.has(packageName)) {
        failures.push(
          `${cataloguePath}: imports package-internal path ${packageName}; import only a declared public package entry`,
        );
        continue;
      }
      const dependency = workspacePackage.logicalDependency;
      if (packageName === filesystemPackage && owner !== 'bootstrap') {
        failures.push(
          `${owner}: imports ${filesystemPackage} but only bootstrap may compose filesystem adapters`,
        );
      }
      if (
        dependency !== undefined &&
        !(manifests.get(owner)?.dependencies ?? []).includes(dependency)
      ) {
        failures.push(
          `${owner}: imports ${packageName} but does not declare dependency ${dependency}`,
        );
      }
    }
  }

  const discovery = discoverCatalogues(sourceDetails, new Set(['stream-literals']));
  failures.push(...discovery.diagnostics.map(({ message }) => message));
  for (const [stream, registrations] of discovery.catalogues.streamValues) {
    const catalogueOwners = registrations.map(({ path }) => path.split('/')[0]).sort();
    if (catalogueOwners.length > 1) {
      failures.push(
        `stream kind ${stream} has duplicate catalogue owners: ${catalogueOwners.join(', ')}`,
      );
    }
    for (const owner of new Set(catalogueOwners)) {
      if (!(manifests.get(owner)?.namespaces?.streams ?? []).includes(stream)) {
        failures.push(`${owner}: stream catalogue value ${stream} is not declared in its manifest`);
      }
    }
  }
  for (const [eventType, registrations] of discovery.catalogues.eventValues) {
    for (const { path, line, column } of registrations) {
      const owner = path.split('/')[0];
      const declared = manifests.get(owner)?.namespaces?.events ?? [];
      if (!declared.some((namespace) => eventType.startsWith(namespace))) {
        failures.push(
          `${path}:${line}:${column} [event-literals] ${eventType} is not declared in ${owner} module manifest events`,
        );
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

  const projectRoot = dirname(resolvedRoot);
  failures.push(...(await checkEventingPackage(join(projectRoot, 'packages/eventing/src'))));
  failures.push(
    ...(await checkEventingFilesystemPackage(
      join(projectRoot, 'packages/eventing-filesystem/src'),
    )),
  );
  return [...new Set(failures)];
}

export async function checkEventingPackage(root = 'packages/eventing/src') {
  return checkWorkspacePackageSource(root, {
    name: '@atolis-hq/eventing',
    allowedExternalImports: new Set(['zod']),
    permitsNodeBuiltins: false,
  });
}

export async function checkEventingFilesystemPackage(root = 'packages/eventing-filesystem/src') {
  return checkWorkspacePackageSource(root, {
    name: filesystemPackage,
    allowedExternalImports: new Set(['@atolis-hq/eventing']),
    permitsNodeBuiltins: true,
  });
}

async function checkWorkspacePackageSource(root, policy) {
  const resolvedRoot = resolve(root);
  let paths;
  try {
    paths = await typescriptFiles(resolvedRoot);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const failures = [];
  for (const path of paths) {
    const source = ts.createSourceFile(
      relative(resolvedRoot, path).split(sep).join('/'),
      await readFile(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    for (const packageName of importedModuleSpecifiers(source)) {
      const localImport = packageName.startsWith('.')
        ? resolve(dirname(path), packageName)
        : undefined;
      if (
        localImport !== undefined &&
        (localImport === resolvedRoot || localImport.startsWith(`${resolvedRoot}${sep}`))
      )
        continue;
      if (policy.permitsNodeBuiltins && packageName.startsWith('node:')) continue;
      if (policy.allowedExternalImports.has(packageName)) continue;
      const detail = policy.permitsNodeBuiltins
        ? 'eventing-filesystem may depend only on @atolis-hq/eventing, Node builtins, and local files'
        : 'eventing may depend only on package dependencies and local files';
      failures.push(`${source.fileName}: imports ${packageName}; ${detail}`);
    }
  }
  return failures;
}

function workspacePackageForSpecifier(specifier) {
  return workspacePackages.find(
    ({ name }) => specifier === name || specifier.startsWith(`${name}/`),
  );
}

function importedModuleSpecifiers(source) {
  const imports = new Set();
  for (const statement of source.statements) {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier !== undefined
    ) {
      imports.add(statement.moduleSpecifier.text);
    }
  }
  return imports;
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
    const moduleCount = (await readdir(resolve('src'), { withFileTypes: true })).filter((entry) =>
      entry.isDirectory(),
    ).length;
    process.stdout.write(`Module manifests valid: ${moduleCount} modules\n`);
  }
}
