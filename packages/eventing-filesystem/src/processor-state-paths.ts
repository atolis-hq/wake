import { join } from 'node:path';
import { assertStorageName, encodeStorageName } from './storage-name.js';

const pendingNamespaceSuffix = ':pending';

export interface ProcessorStatePaths {
  readonly key: string;
  readonly namespace: string;
  readonly current: string;
  readonly isolated: string;
  readonly legacy: string;
}

export function processorStatePaths(
  root: string,
  consumer: string,
  key: string,
): ProcessorStatePaths {
  const namespace = processorStateNamespace(consumer);
  const currentNamespace = encodeProcessorStateName(namespace);
  const currentKey = encodeProcessorStateName(key);
  return {
    key,
    namespace,
    current: processorStatePath(root, currentNamespace, currentKey),
    isolated: processorStatePath(
      root,
      `%processor-state-${currentNamespace}`,
      `%processor-state-${currentKey}`,
    ),
    legacy: processorStatePath(root, encodeStorageName(namespace), encodeStorageName(key)),
  };
}

export function processorStateDirectoryNames(consumer: string): readonly string[] {
  const namespace = processorStateNamespace(consumer);
  const current = encodeProcessorStateName(namespace);
  return [...new Set([current, `%processor-state-${current}`, encodeStorageName(namespace)])];
}

function processorStateNamespace(consumer: string): string {
  assertStorageName(consumer);
  return `${consumer}${pendingNamespaceSuffix}`;
}

function encodeProcessorStateName(value: string): string {
  assertStorageName(value);
  return encodeURIComponent(value)
    .replace(/~/g, '%7E')
    .replace(/%(?!7E)/g, '~')
    .replace(/\./g, '~2E');
}

function processorStatePath(root: string, namespace: string, key: string): string {
  return join(root, 'projections', namespace, `${key}.json`);
}
