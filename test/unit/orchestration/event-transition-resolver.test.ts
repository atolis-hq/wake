import { expect, it } from 'vitest';

import {
  selectEarliestEventTransition,
  type EventTransitionResolution,
} from '../../../src/orchestration/index.js';

const resolution = (evidenceId: string, position: number): EventTransitionResolution => ({
  evidenceId,
  position,
  target: { kind: 'complete' },
});

it('selects the earliest event transition before an incoming signal', () => {
  expect(
    selectEarliestEventTransition([resolution('before', 10), resolution('after', 20)], 20),
  ).toEqual(resolution('before', 10));
});
