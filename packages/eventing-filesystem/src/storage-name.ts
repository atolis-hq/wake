export function assertWellFormedUtf16(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff))
        throw new Error(`${label} must use well-formed UTF-16`);
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new Error(`${label} must use well-formed UTF-16`);
    }
  }
}

export function assertStorageName(value: string): void {
  assertWellFormedUtf16(value, 'Storage name');
  if (value.length === 0 || /[\\/]/.test(value))
    throw new Error('Storage name must not contain path separators');
}

export function encodeStorageName(value: string): string {
  assertStorageName(value);
  return encodeURIComponent(value).replace(/%/g, '~').replace(/\./g, '~2E');
}

export function encodeCheckpointStorageName(consumer: string): string {
  assertStorageName(consumer);
  return Buffer.from(consumer, 'utf8').toString('base64url');
}
