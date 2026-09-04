import { assertStorageName } from './storage-name.js';

export interface CompatibleProcessorStateRecord {
  readonly namespace: string;
  readonly key: string;
  readonly lastGlobalPosition: number;
  readonly value: unknown;
}

const pendingNamespaceSuffix = ':pending';

export function isCompatibleProcessorStateRecord(
  value: unknown,
): value is CompatibleProcessorStateRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.namespace === 'string' &&
    typeof record.key === 'string' &&
    isProcessorStateNamespace(record.namespace) &&
    isStorageName(record.key) &&
    Number.isInteger(record.lastGlobalPosition) &&
    record.lastGlobalPosition === 0 &&
    Object.hasOwn(record, 'value')
  );
}

function isProcessorStateNamespace(namespace: string): boolean {
  if (!namespace.endsWith(pendingNamespaceSuffix)) return false;
  return isStorageName(namespace.slice(0, -pendingNamespaceSuffix.length));
}

function isStorageName(value: string): boolean {
  try {
    assertStorageName(value);
    return true;
  } catch {
    return false;
  }
}
