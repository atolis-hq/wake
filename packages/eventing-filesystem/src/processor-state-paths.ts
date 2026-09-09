import { join } from 'node:path';
import { assertStorageName, projectionStorageAddress } from './storage-name.js';

const pendingNamespaceSuffix = ':pending';

export interface ProcessorStatePaths {
  readonly key: string;
  readonly namespace: string;
  readonly current: string;
}

export function processorStatePaths(
  root: string,
  consumer: string,
  key: string,
): ProcessorStatePaths {
  assertStorageName(consumer);
  assertStorageName(key);
  return {
    key,
    namespace: `${consumer}${pendingNamespaceSuffix}`,
    current: join(
      root,
      'projections',
      'processor-state',
      projectionStorageAddress(consumer),
      `${projectionStorageAddress(key)}.json`,
    ),
  };
}
