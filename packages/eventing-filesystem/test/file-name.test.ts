import { expect, it } from 'vitest';
import { projectionStorageAddress } from '../src/storage-name.js';

it('uses bounded, filesystem-safe addresses for projection names', () => {
  const address = projectionStorageAddress('projection:operator-board');
  expect(address).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(address).not.toMatch(/[~%]/);
});

it('distinguishes projection names with different source characters', () => {
  expect(projectionStorageAddress('item~24')).not.toBe(projectionStorageAddress('item$'));
});
