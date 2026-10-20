import { expect, it } from 'vitest';
import {
  buildReservation,
  matchesAssignments,
} from '../../../src/orchestration/application/delegation-reservation.js';
import type { DelegatedAssignment } from '../../../src/orchestration/contracts/delegation.js';
import { workflowInstanceId, workflowName } from '../../../src/orchestration/index.js';
import { workId } from '../../support/identities.js';

it('pins two named sources across duplicate requests without widening repository scope', () => {
  const repository = {
    resourceId: 'repo',
    sourceRef: 'main',
    sourceRevision: 'a'.repeat(40),
    pullRequestBase: 'main',
  };
  const assignment: DelegatedAssignment = {
    assignmentId: 'both',
    objective: 'Deliver both',
    criteria: ['Both qualify'],
    workflowName: workflowName('child'),
    workflowFingerprint: 'fp',
    context: [],
    repository,
    outputs: [
      { name: 'api', kind: 'change' },
      {
        name: 'web',
        kind: 'change',
        repository: {
          ...repository,
          sourceRef: 'release',
          sourceRevision: 'b'.repeat(40),
          pullRequestBase: 'release',
        },
      },
    ],
  };
  const parent = {
    workflowInstanceId: workflowInstanceId('parent'),
    workItemId: workId('parent'),
    rootWorkItemId: workId('parent'),
    ancestors: [workId('parent')],
  };
  const caller = {
    workflowInstanceId: parent.workflowInstanceId,
    activationId: 'act',
    runId: 'run',
  } as never;
  const reserved = buildReservation(parent, caller, 'cohort', [assignment], {
    maxDepth: 1,
    maxDescendants: 2,
  });
  const request = {
    ...assignment,
    repository: { ...repository, sourceRevision: undefined },
    outputs: [
      assignment.outputs[0]!,
      {
        ...assignment.outputs[1]!,
        repository: {
          ...repository,
          sourceRef: 'release',
          sourceRevision: undefined,
          pullRequestBase: 'release',
        },
      },
    ],
  };
  expect(matchesAssignments(reserved, [request] as never)).toBe(true);
  expect(
    matchesAssignments(reserved, [
      {
        ...assignment,
        outputs: [
          assignment.outputs[0]!,
          {
            ...assignment.outputs[1]!,
            repository: {
              ...repository,
              sourceRef: 'release',
              pullRequestBase: 'release',
              sourceRevision: 'c'.repeat(40),
            },
          },
        ],
      },
    ]),
  ).toBe(false);
  expect(() =>
    buildReservation(
      parent,
      caller,
      'other',
      [
        {
          ...assignment,
          outputs: [
            {
              name: 'web',
              kind: 'change',
              repository: { ...repository, resourceId: 'unauthorized' },
            },
          ],
        },
      ],
      { maxDepth: 1, maxDescendants: 2 },
    ),
  ).toThrow('assigned repository');
});
