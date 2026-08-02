import { expect, it } from 'vitest';
import { foldRun } from '../../../src-next/execution/index.js';

it('keeps transport status separate from the Activity outcome', () => {
  expect(foldRun([])).toBeNull();
});
