import { join } from 'node:path';
import { assertStorageName, projectionStorageAddress } from './storage-name.js';

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
  const current = processorStatePath(
    root,
    `v3-state-${projectionStorageAddress(namespace)}`,
    projectionStorageAddress(key),
  );
  return { key, namespace, current, isolated: current, legacy: current };
}

export function processorStateDirectoryNames(consumer: string): readonly string[] {
  const namespace = processorStateNamespace(consumer);
  return [`v3-state-${projectionStorageAddress(namespace)}`];
}

function processorStateNamespace(consumer: string): string {
  assertStorageName(consumer);
  return `${consumer}${pendingNamespaceSuffix}`;
}

function processorStatePath(root: string, namespace: string, key: string): string {
  return join(root, 'projections', namespace, `${key}.json`);
}
