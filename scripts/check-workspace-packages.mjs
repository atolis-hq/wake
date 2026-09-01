#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageLocations = [
  { directory: repoRoot, label: 'Wake' },
  {
    directory: resolve(repoRoot, 'packages/eventing'),
    label: 'Eventing',
    verifySourceOutputs: true,
  },
  {
    directory: resolve(repoRoot, 'packages/eventing-filesystem'),
    label: 'Eventing filesystem',
    verifySourceOutputs: true,
  },
];
const requiredArchiveFiles = ['README.md', 'LICENSE'];

function fail(message) {
  throw new Error(message);
}

function run(command, arguments_, cwd) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, arguments_, {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', rejectRun);
    child.once('close', (code) => {
      if (code === 0) {
        resolveRun({ stderr, stdout });
        return;
      }
      rejectRun(
        new Error(
          `${command} ${arguments_.join(' ')} failed with exit code ${code ?? 'unknown'}\n${stdout}${stderr}`,
        ),
      );
    });
  });
}

function runNpm(arguments_, cwd) {
  if (process.platform !== 'win32') return run('npm', arguments_, cwd);

  const npmCli =
    process.env.npm_execpath ??
    resolve(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return run(process.execPath, [npmCli, ...arguments_], cwd);
}

async function readManifest(directory) {
  return JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
}

function requireExactInternalVersions(manifests) {
  const wake = manifests[0];
  const eventing = manifests[1];
  const filesystem = manifests[2];
  const version = wake.version;

  if (typeof version !== 'string' || version.length === 0) fail('Wake must declare a version.');
  for (const manifest of [eventing, filesystem]) {
    if (manifest.version !== version) {
      fail(
        `${manifest.name} must use Wake version ${version}; found ${manifest.version ?? '<missing>'}.`,
      );
    }
  }

  const requirements = [
    [wake.name, wake.dependencies?.[eventing.name], eventing.name],
    [wake.name, wake.dependencies?.[filesystem.name], filesystem.name],
    [filesystem.name, filesystem.dependencies?.[eventing.name], eventing.name],
  ];
  for (const [owner, dependencyVersion, dependencyName] of requirements) {
    if (dependencyVersion !== version) {
      fail(
        `${owner} must depend on ${dependencyName} at exact version ${version}; found ${dependencyVersion ?? '<missing>'}.`,
      );
    }
  }
}

function exportedPaths(value) {
  if (typeof value === 'string') return [value];
  if (value !== null && typeof value === 'object') {
    return Object.values(value).flatMap((entry) => exportedPaths(entry));
  }
  return [];
}

function publicDistEntries(manifest) {
  const entries = [manifest.main, manifest.types, ...exportedPaths(manifest.exports)];
  if (typeof manifest.bin === 'string') entries.push(manifest.bin);
  if (manifest.bin !== null && typeof manifest.bin === 'object') {
    entries.push(...Object.values(manifest.bin));
  }

  return [...new Set(entries.filter((entry) => typeof entry === 'string'))]
    .map((entry) => entry.replace(/^\.\//u, ''))
    .filter((entry) => entry.startsWith('dist/') && /\.(?:js|d\.ts)$/u.test(entry));
}

async function sourceFiles(directory, relativeDirectory = '') {
  const entries = await readdir(resolve(directory, relativeDirectory), { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const relativePath = `${relativeDirectory}${entry.name}`;
      if (entry.isDirectory()) return sourceFiles(directory, `${relativePath}/`);
      return entry.isFile() ? [relativePath] : [];
    }),
  );
  return files.flat();
}

async function expectedArchiveFiles(directory) {
  const outputs = (await sourceFiles(resolve(directory, 'src'))).flatMap((file) => {
    if (!file.endsWith('.ts') || file.endsWith('.d.ts')) return [];
    const output = file.slice(0, -3);
    return [`dist/${output}.js`, `dist/${output}.d.ts`, `dist/${output}.d.ts.map`];
  });
  return new Set(['package.json', ...requiredArchiveFiles, ...outputs]);
}

function parsePackOutput(output, label) {
  let jsonStart = output.lastIndexOf('[');
  while (jsonStart >= 0) {
    try {
      const entries = JSON.parse(output.slice(jsonStart).trim());
      if (Array.isArray(entries)) {
        const entry = entries[0];
        if (entry !== undefined && typeof entry === 'object') return entry;
      }
    } catch {
      // Lifecycle output can contain bracket-prefixed build warnings before npm's final JSON array.
    }
    jsonStart = output.lastIndexOf('[', jsonStart - 1);
  }

  fail(`${label} npm pack did not return archive JSON metadata.`);
}

async function verifyPackedEntries(manifest, packed, directory, label, verifySourceOutputs) {
  if (packed.name !== manifest.name || packed.version !== manifest.version) {
    fail(`${label} npm pack metadata does not match its package manifest.`);
  }

  const files = new Set(
    Array.isArray(packed.files)
      ? packed.files.map((file) => file?.path).filter((path) => typeof path === 'string')
      : [],
  );
  const entries = publicDistEntries(manifest);
  if (entries.length === 0)
    fail(`${label} has no declared JavaScript or declaration dist entrypoints.`);
  for (const entry of entries) {
    if (!files.has(entry)) fail(`${label} archive is missing declared public entry ${entry}.`);
  }
  for (const file of requiredArchiveFiles) {
    if (!files.has(file)) fail(`${label} archive is missing required package file ${file}.`);
  }

  if (verifySourceOutputs) {
    const expectedFiles = await expectedArchiveFiles(directory);
    for (const file of files) {
      if (!expectedFiles.has(file)) {
        fail(`${label} archive contains unexpected package artifact ${file}.`);
      }
    }
  }
}

function archivePath(packed, directory, label) {
  if (typeof packed.filename !== 'string' || packed.filename.length === 0) {
    fail(`${label} npm pack did not provide an archive filename.`);
  }
  return resolve(directory, packed.filename);
}

function packageFileRequirement(projectDirectory, archive) {
  return `file:${relative(projectDirectory, archive).replaceAll('\\', '/')}`;
}

async function assertRegularDirectory(path, label) {
  if ((await lstat(path)).isSymbolicLink())
    fail(`${label} must be installed from an archive, not a symlink.`);
}

async function verifyCleanInstall(manifests, archives, projectDirectory) {
  const dependencies = Object.fromEntries(
    archives.map((archive, index) => [
      manifests[index].name,
      packageFileRequirement(projectDirectory, archive),
    ]),
  );
  await writeFile(
    resolve(projectDirectory, 'package.json'),
    `${JSON.stringify({ name: 'wake-package-check', private: true, version: '0.0.0', dependencies }, null, 2)}\n`,
  );

  await runNpm(
    ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'],
    projectDirectory,
  );

  const lock = JSON.parse(await readFile(resolve(projectDirectory, 'package-lock.json'), 'utf8'));
  for (const [index, manifest] of manifests.entries()) {
    const packagePath = `node_modules/${manifest.name}`;
    const installed = lock.packages?.[packagePath];
    const archiveName = basename(archives[index]);
    if (
      typeof installed?.resolved !== 'string' ||
      !installed.resolved.startsWith('file:') ||
      !installed.resolved.includes(archiveName)
    ) {
      fail(`${manifest.name} was not resolved from local archive ${archiveName}.`);
    }
    await assertRegularDirectory(resolve(projectDirectory, packagePath), manifest.name);
  }

  await run(
    process.execPath,
    ['node_modules/@atolis-hq/wake/dist/src/main.js', '--help'],
    projectDirectory,
  );
  await runNpm(['exec', '--offline', '--', 'wake', '--help'], projectDirectory);
}

async function main() {
  const manifests = await Promise.all(
    packageLocations.map(({ directory }) => readManifest(directory)),
  );
  requireExactInternalVersions(manifests);

  const temporaryDirectory = await mkdtemp(resolve(tmpdir(), 'wake-workspace-packages-'));
  try {
    const archiveDirectory = resolve(temporaryDirectory, 'archives');
    const installDirectory = resolve(temporaryDirectory, 'install');
    await Promise.all([mkdir(archiveDirectory), mkdir(installDirectory)]);

    const archives = [];
    for (const [index, location] of packageLocations.entries()) {
      const manifest = manifests[index];
      const dryRun = parsePackOutput(
        (await runNpm(['pack', '--dry-run', '--json'], location.directory)).stdout,
        location.label,
      );
      await verifyPackedEntries(
        manifest,
        dryRun,
        location.directory,
        location.label,
        location.verifySourceOutputs,
      );

      const packed = parsePackOutput(
        (
          await runNpm(
            ['pack', '--json', '--pack-destination', archiveDirectory],
            location.directory,
          )
        ).stdout,
        location.label,
      );
      await verifyPackedEntries(
        manifest,
        packed,
        location.directory,
        location.label,
        location.verifySourceOutputs,
      );
      const archive = archivePath(packed, archiveDirectory, location.label);
      if (!(await stat(archive)).isFile())
        fail(`${location.label} archive was not written: ${archive}`);
      archives.push(archive);
    }

    await verifyCleanInstall(manifests, archives, installDirectory);
    console.log('Workspace package archive check passed');
  } finally {
    await rm(temporaryDirectory, { force: true, maxRetries: 3, recursive: true, retryDelay: 100 });
  }
}

await main();
