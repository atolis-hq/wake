import { expect, it } from 'vitest';
import { foldRun } from '../../../src/execution/index.js';

it('keeps transport status separate from the Activity outcome', () => {
  expect(foldRun([])).toBeNull();
});
