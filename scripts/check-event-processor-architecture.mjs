import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const processorHostPattern = /\bEventProcessorHost\b/;
const processorSerialiserPattern =
  /\b(?:createInMemoryProcessorRunSerialiser|createFileProcessorRunSerialiser)\b/;
const processorRegistryPattern = /\bEventProcessorRuntime\b/;
const processorHandlerPattern = /\bhandle\s*(?::|\()/;

/**
 * Enforce the ownership seams around the event-processing runtime.
 *
 * Definitions and handlers stay with bounded modules, while runtime
 * construction and the complete registry stay in Bootstrap. Persistence
 * supplies storage adapters only; it never defines processor handlers.
 */
export async function checkEventProcessorArchitecture(root = 'src') {
  const resolvedRoot = resolve(root);
  const sourceRoot = (await directoryExists(join(resolvedRoot, 'src')))
    ? join(resolvedRoot, 'src')
    : resolvedRoot;
  const files = await typescriptFiles(sourceRoot);
  const diagnostics = [];

  for (const file of files) {
    const source = await readFile(file, 'utf8');
    const relativePath = relative(sourceRoot, file).split(sep).join('/');
    const moduleName = relativePath.split('/')[0];
    const code = stripComments(source);
    const location = (pattern) => lineLocation(source, pattern);

    if (processorHostPattern.test(code) && !['eventing', 'bootstrap'].includes(moduleName)) {
      diagnostics.push({
        message: `${relativePath}:${location(processorHostPattern)} [event-processor-host-owner] EventProcessorHost may only be referenced by eventing or bootstrap`,
      });
    }
    if (
      processorSerialiserPattern.test(code) &&
      !['persistence', 'bootstrap'].includes(moduleName)
    ) {
      diagnostics.push({
        message: `${relativePath}:${location(processorSerialiserPattern)} [processor-serialiser-owner] concrete processor serialisers may only be referenced by persistence or bootstrap`,
      });
    }
    if (processorRegistryPattern.test(code) && moduleName !== 'bootstrap') {
      diagnostics.push({
        message: `${relativePath}:${location(processorRegistryPattern)} [processor-registry-owner] the complete EventProcessorRuntime may only be composed by bootstrap`,
      });
    }
    if (moduleName === 'persistence' && processorHandlerPattern.test(code)) {
      diagnostics.push({
        message: `${relativePath}:${location(processorHandlerPattern)} [persistence-processor-handler] persistence may not define processor handlers`,
      });
    }
  }

  return diagnostics;
}

async function typescriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await typescriptFiles(path)));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path);
  }
  return files.sort();
}

async function directoryExists(path) {
  try {
    const entries = await readdir(path);
    return entries !== undefined;
  } catch {
    return false;
  }
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function lineLocation(source, pattern) {
  const match = pattern.exec(source);
  if (match === null || match.index === undefined) return 1;
  return source.slice(0, match.index).split(/\r?\n/).length;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  const diagnostics = await checkEventProcessorArchitecture();
  if (diagnostics.length > 0) {
    process.stderr.write(`${diagnostics.map(({ message }) => message).join('\n')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('Event processor architecture valid\n');
  }
}
