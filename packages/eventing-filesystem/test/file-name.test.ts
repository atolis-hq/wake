import { expect, it } from 'vitest';
import { encode } from '../src/file-projection-store.js';

it('uses filesystem-safe storage names without percent escapes', () => {
  expect(encode('projection:operator-board')).toBe('projection~3Aoperator-board');
  expect(encode('agent-run:run-1')).not.toContain('%');
});

it('distinguishes literal tildes from percent-escaped characters', () => {
  expect(encode('item~24')).toBe('item%7E24');
  expect(encode('item$')).toBe('item~24');
});
