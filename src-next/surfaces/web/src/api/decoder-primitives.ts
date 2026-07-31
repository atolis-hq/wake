import type { ResponseMeta } from '../../../api/contracts/index.js';

export type Decoder<Value> = (value: unknown, path?: string) => Value;

export function decodeMeta(value: unknown, path: string): ResponseMeta {
  const record = object(value, path);
  return {
    asOf: string(record.asOf, child(path, 'asOf')),
    ...optionalNumberProperty(record, 'position', path),
  };
}

export function object(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) invalid(path);
  return value;
}

export function array<Value>(
  value: unknown,
  path: string,
  decode: Decoder<Value>,
): readonly Value[] {
  if (!Array.isArray(value)) invalid(path);
  return value.map((item, index) => decode(item, `${path}[${index}]`));
}

export function string(value: unknown, path = ''): string {
  if (typeof value !== 'string') invalid(path);
  return value;
}

export function nullableString(value: unknown, path: string): string | null {
  return value === null ? null : string(value, path);
}

export function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') invalid(path);
  return value;
}

export function number(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(path);
  return value;
}

export function optionalStringProperty(record: Record<string, unknown>, key: string, path: string) {
  return record[key] === undefined ? {} : { [key]: string(record[key], child(path, key)) };
}

export function optionalNumberProperty(record: Record<string, unknown>, key: string, path: string) {
  return record[key] === undefined ? {} : { [key]: number(record[key], child(path, key)) };
}

export function json(value: unknown, path: string): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return value;
  if (Array.isArray(value)) return value.map((item, index) => json(item, `${path}[${index}]`));
  const record = object(value, path);
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [key, json(item, child(path, key))]),
  );
}

export function child(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`;
}

export function invalid(path: string): never {
  throw new Error(`Invalid Wake API response at ${path === '' ? 'root' : path}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
