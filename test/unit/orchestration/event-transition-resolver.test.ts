import { expect, it } from 'vitest';

import {
  selectEarliestResourceTransition,
  type ResourceTransitionResolution,
} from '../../../src/orchestration/index.js';

const resolution = (evidenceId: string, position: number): ResourceTransitionResolution => ({
  evidenceId,
  position,
  target: { kind: 'complete' },
});

it('selects the earliest event transition before an incoming signal', () => {
  expect(
    selectEarliestResourceTransition([resolution('before', 10), resolution('after', 20)], 20),
  ).toEqual(resolution('before', 10));
});
