import { expect, it } from 'vitest';
import { BoardCondition } from '../../../src/surfaces/api/contracts/board.js';

it('keeps status condition vocabulary closed and degrades unavailable facts explicitly', () => {
  expect(BoardCondition).toEqual({
    Ready: 'ready',
    Active: 'active',
    NeedsInput: 'needs-input',
    Error: 'error',
    Finished: 'finished',
  });
  expect(Object.values(BoardCondition)).not.toContain('scheduled');
});
