#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageLocations = [{ directory: repoRoot, label: 'Wake' }];
const requiredArchiveFiles = ['README.md', 'LICENSE'];
const embeddedRuntimePackages = ['eventing', 'eventing-filesystem'];
const requiredEmbeddedRuntimeFiles = ['package.json', 'README.md', 'LICENSE'];

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

function packedFileSet(packed) {
  return new Set(
    Array.isArray(packed.files)
      ? packed.files.map((file) => file?.path).filter((path) => typeof path === 'string')
      : [],
  );
}

function requirePackedFile(files, path, label) {
  if (!files.has(path)) fail(`${label} archive is missing required package file ${path}.`);
}

function verifyPackedEntries(manifest, packed, label) {
  if (packed.name !== manifest.name || packed.version !== manifest.version) {
    fail(`${label} npm pack metadata does not match its package manifest.`);
  }

  const files = packedFileSet(packed);
  const entries = publicDistEntries(manifest);
  if (entries.length === 0)
    fail(`${label} has no declared JavaScript or declaration dist entrypoints.`);
  for (const entry of entries) requirePackedFile(files, entry, label);
  for (const file of requiredArchiveFiles) requirePackedFile(files, file, label);

  for (const packageName of embeddedRuntimePackages) {
    const runtimeRoot = `dist/src/node_modules/@atolis-hq/${packageName}`;
    for (const file of requiredEmbeddedRuntimeFiles) {
      requirePackedFile(files, `${runtimeRoot}/${file}`, label);
    }
    requirePackedFile(files, `${runtimeRoot}/dist/index.js`, label);
    requirePackedFile(files, `${runtimeRoot}/dist/index.d.ts`, label);
  }
  requirePackedFile(files, 'dist/src/node_modules/@atolis-hq/eventing/dist/memory.js', label);
  requirePackedFile(files, 'dist/src/node_modules/@atolis-hq/eventing/dist/memory.d.ts', label);
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
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    fail(`${label} must be an ordinary directory installed from the Wake archive.`);
  }
}

async function assertEmbeddedRuntime(projectDirectory) {
  const runtimeRoot = resolve(
    projectDirectory,
    'node_modules/@atolis-hq/wake/dist/src/node_modules/@atolis-hq',
  );
  for (const packageName of embeddedRuntimePackages) {
    const packageDirectory = resolve(runtimeRoot, packageName);
    await assertRegularDirectory(packageDirectory, `Embedded ${packageName}`);
    for (const file of requiredEmbeddedRuntimeFiles) {
      if (!(await stat(resolve(packageDirectory, file))).isFile()) {
        fail(`Embedded ${packageName} is missing ${file}.`);
      }
    }
    if (!(await stat(resolve(packageDirectory, 'dist/index.js'))).isFile()) {
      fail(`Embedded ${packageName} is missing dist/index.js.`);
    }
  }
  if (!(await stat(resolve(runtimeRoot, 'eventing/dist/memory.js'))).isFile()) {
    fail('Embedded eventing is missing dist/memory.js.');
  }
}

async function verifyCleanInstall(manifest, archive, projectDirectory) {
  const dependencies = {
    [manifest.name]: packageFileRequirement(projectDirectory, archive),
  };
  await writeFile(
    resolve(projectDirectory, 'package.json'),
    `${JSON.stringify({ name: 'wake-package-check', private: true, version: '0.0.0', dependencies }, null, 2)}\n`,
  );

  await runNpm(
    ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'],
    projectDirectory,
  );

  const lock = JSON.parse(await readFile(resolve(projectDirectory, 'package-lock.json'), 'utf8'));
  const installed = lock.packages?.[`node_modules/${manifest.name}`];
  const archiveName = basename(archive);
  if (
    typeof installed?.resolved !== 'string' ||
    !installed.resolved.startsWith('file:') ||
    !installed.resolved.includes(archiveName)
  ) {
    fail(`${manifest.name} was not resolved from local archive ${archiveName}.`);
  }
  await assertRegularDirectory(
    resolve(projectDirectory, `node_modules/${manifest.name}`),
    manifest.name,
  );
  await assertEmbeddedRuntime(projectDirectory);

  await run(
    process.execPath,
    ['node_modules/@atolis-hq/wake/dist/src/main.js', '--help'],
    projectDirectory,
  );
  await runNpm(['exec', '--offline', '--', 'wake', '--help'], projectDirectory);
}

async function main() {
  const [{ directory, label }] = packageLocations;
  const manifest = await readManifest(directory);
  if (manifest.dependencies?.['@atolis-hq/eventing'] !== undefined) {
    fail('Wake must embed Eventing instead of declaring it as a dependency.');
  }
  if (manifest.dependencies?.['@atolis-hq/eventing-filesystem'] !== undefined) {
    fail('Wake must embed Eventing filesystem instead of declaring it as a dependency.');
  }

  const temporaryDirectory = await mkdtemp(resolve(tmpdir(), 'wake-workspace-packages-'));
  try {
    const archiveDirectory = resolve(temporaryDirectory, 'archives');
    const installDirectory = resolve(temporaryDirectory, 'install');
    await Promise.all([mkdir(archiveDirectory), mkdir(installDirectory)]);

    const dryRun = parsePackOutput(
      (await runNpm(['pack', '--dry-run', '--json'], directory)).stdout,
      label,
    );
    verifyPackedEntries(manifest, dryRun, label);

    const packed = parsePackOutput(
      (await runNpm(['pack', '--json', '--pack-destination', archiveDirectory], directory)).stdout,
      label,
    );
    verifyPackedEntries(manifest, packed, label);
    const archive = archivePath(packed, archiveDirectory, label);
    if (!(await stat(archive)).isFile()) fail(`${label} archive was not written: ${archive}`);

    await verifyCleanInstall(manifest, archive, installDirectory);
    console.log('Wake package archive check passed');
  } finally {
    await rm(temporaryDirectory, { force: true, maxRetries: 3, recursive: true, retryDelay: 100 });
  }
}

await main();
