import { join } from 'node:path';
import { assertStorageName, encodeLegacyStorageName, encodeStorageName } from './storage-name.js';

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
  const currentNamespace = encodeStorageName(namespace);
  const currentKey = encodeStorageName(key);
  return {
    key,
    namespace,
    current: processorStatePath(root, currentNamespace, currentKey),
    isolated: processorStatePath(
      root,
      `%processor-state-${currentNamespace}`,
      `%processor-state-${currentKey}`,
    ),
    legacy: processorStatePath(
      root,
      encodeLegacyStorageName(namespace),
      encodeLegacyStorageName(key),
    ),
  };
}

export function processorStateDirectoryNames(consumer: string): readonly string[] {
  const namespace = processorStateNamespace(consumer);
  const current = encodeStorageName(namespace);
  return [...new Set([current, `%processor-state-${current}`, encodeLegacyStorageName(namespace)])];
}

function processorStateNamespace(consumer: string): string {
  assertStorageName(consumer);
  return `${consumer}${pendingNamespaceSuffix}`;
}

function processorStatePath(root: string, namespace: string, key: string): string {
  return join(root, 'projections', namespace, `${key}.json`);
}
