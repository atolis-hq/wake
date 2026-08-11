export { resourceResponse as presentSystem } from '../contracts/common.js';

export function redactConfiguration(value: object): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      /secret|token|password|credential|key/i.test(key) ? '[redacted]' : redactValue(item),
    ]),
  );
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (typeof value === 'object' && value !== null) return redactConfiguration(value);
  return value;
}
