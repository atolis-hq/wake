import { expect, it } from 'vitest';
import { encode } from '../../../src-next/persistence/filesystem/file-projection-store.js';

it('uses filesystem-safe storage names without percent escapes', () => {
  expect(encode('projection:operator-board')).toBe('projection~3Aoperator-board');
  expect(encode('agent-run:run-1')).not.toContain('%');
});
