import { expect, it } from 'vitest';
import { WorkEventType } from '../../../work/index.js';
import { TriggerStatus, type TriggerResponse } from '../../api/contracts/index.js';
import { decodeTrigger, decodeTriggers } from '../src/api/trigger-decoders.js';

const manual = { kind: 'manual', commandId: 'run-now', operator: 'web' } as const;
const automatic = {
  kind: 'event',
  eventId: 'observation',
  eventType: WorkEventType.ObjectiveRevised,
} as const;
const trigger: TriggerResponse = {
  triggerId: 'oversight',
  status: TriggerStatus.Paused,
  definition: null,
  paused: true,
  pauseReason: 'Operator pause',
  nextOccurrence: null,
  pending: [
    {
      triggerId: 'oversight',
      coordinationKey: 'shared',
      source: manual,
      sources: [manual, automatic],
      disposition: 'coalesced',
      manualOutcome: { disposition: 'coalesced', activeWorkItemId: 'work-active' },
    },
  ],
  latestSkip: null,
  invocations: [],
};

it('decodes pending manual and automatic provenance without coordination recovery state', () => {
  expect(decodeTrigger(trigger)).toEqual(trigger);
  expect(decodeTriggers([trigger])).toEqual([trigger]);
  const decoded = decodeTrigger({
    ...trigger,
    pending: [{ ...trigger.pending[0], manualRequests: [{ privateCoordinationState: true }] }],
  });
  expect(decoded.pending).toEqual(trigger.pending);
  expect(decoded.pending[0]).not.toHaveProperty('manualRequests');
});

it('rejects malformed pending sources and manual outcomes', () => {
  expect(() =>
    decodeTrigger({ ...trigger, pending: [{ ...trigger.pending[0], source: { kind: 'manual' } }] }),
  ).toThrow();
  expect(() =>
    decodeTrigger({
      ...trigger,
      pending: [
        {
          ...trigger.pending[0],
          manualOutcome: { disposition: 'skipped', reason: 'invalid-skip-reason' },
        },
      ],
    }),
  ).toThrow();
});
