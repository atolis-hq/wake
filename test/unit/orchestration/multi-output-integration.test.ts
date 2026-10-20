import { expect, it, vi } from 'vitest';
import { BuiltInActivityName, ParentActionKind } from '../../../src/activities/index.js';
import { DeliveryIntegrationService } from '../../../src/orchestration/application/delivery-integration-service.js';
import type {
  DeliveryCandidate,
  DeliveryQa,
  DeliverySelection,
} from '../../../src/orchestration/contracts/delivery.js';
import { staleEntries } from '../../../src/orchestration/domain/delivery-selection.js';
import { OrchestrationEventType } from '../../../src/orchestration/index.js';
import { resId, workId } from '../../support/identities.js';

it('requires a named parent target for two PRs from one child and preserves its owner (DC-29, DC-33)', async () => {
  const child = workId('multi-child');
  const parent = workId('multi-parent');
  const selection: DeliverySelection = {
    requestId: 'selection',
    revision: 1,
    entries: ['api', 'web'].map((name, index) => ({
      cohortId: 'cohort',
      assignmentId: 'coherent',
      childWorkItemId: child,
      output: {
        name,
        reference: {
          workItemId: child,
          resourceId: resId(name),
          repositoryResourceId: 'repo',
          revision: String(index + 1).repeat(40),
          branch: name,
          pullRequestBase: 'main',
          runId: 'child-run',
        },
      },
    })),
  };
  const candidate: DeliveryCandidate = {
    candidateId: 'candidate',
    selectionRevision: 1,
    context: [],
    criteria: ['Both outputs'],
    repositories: [
      {
        resourceId: 'repo',
        revision: '3'.repeat(40),
        pullRequestBase: 'main',
        source: { kind: 'retained-ref', ref: 'refs/wake/delivery/root/candidate/combined' },
        contributions: ['api', 'web'].map((outputName) => ({ childWorkItemId: child, outputName })),
      },
    ],
  };
  const qa: DeliveryQa = {
    qaId: 'qa',
    candidateId: 'candidate',
    verdict: 'pass',
    environment: { available: true },
    findings: [],
    revisions: [{ resourceId: 'repo', revision: '3'.repeat(40) }],
    runId: 'qa-run',
    activationId: 'qa-activation',
  };
  const events = [
    { event: { eventType: OrchestrationEventType.DeliverySelectionRevised, payload: selection } },
    { event: { eventType: OrchestrationEventType.DeliveryCandidateRecorded, payload: candidate } },
    { event: { eventType: OrchestrationEventType.DeliveryQaRecorded, payload: qa } },
  ];
  let valid = true;
  const verifyTarget = vi.fn(async () => valid);
  const service = new DeliveryIntegrationService(
    {
      load: async () => ({
        view: {
          workflowInstanceId: 'parent',
          workItemId: parent,
          pendingActivation: {
            activationId: 'merge',
            activity: BuiltInActivityName.PullRequestMerge,
          },
        },
      }),
      history: async () => ({ events }),
      events: async () => events,
    } as never,
    {
      definitionFor: async () => ({
        delegation: { qa: { stage: 'qa' }, completion: 'merge-required' },
      }),
      integration: {
        verifyTarget,
        observe: async (id: string) => ({
          state: 'open',
          headRevision: (id === resId('api') ? '1' : '2').repeat(40),
          baseRevision: 'unknown',
        }),
      },
    } as never,
  );
  const request = {
    workflowInstanceId: 'parent',
    activationId: 'merge',
    action: ParentActionKind.Merge,
  } as const;
  expect(await service.authorize(request as never)).toEqual({
    kind: 'denied',
    reason: 'ambiguous-resource',
  });
  expect(verifyTarget).not.toHaveBeenCalled();
  const explicit = { ...request, output: { childWorkItemId: child, outputName: 'web' } };
  expect(await service.authorize(explicit as never)).toMatchObject({
    kind: 'target',
    resourceId: resId('web'),
    revision: '2'.repeat(40),
    context: { ownerWorkItemId: child, requestingWorkItemId: parent, output: explicit.output },
  });
  expect(verifyTarget).toHaveBeenCalledWith(
    expect.objectContaining({
      resourceId: resId('web'),
      ownerWorkItemId: child,
      requireReview: true,
      requireChecks: true,
    }),
  );
  valid = false;
  expect(await service.authorize(explicit as never)).toEqual({
    kind: 'denied',
    reason: 'delivery-not-ready',
  });
  expect(
    await service.authorize({
      ...explicit,
      output: { childWorkItemId: child, outputName: 'missing' },
    } as never),
  ).toMatchObject({ kind: 'denied' });
});

it('stales only the consumers of the replaced output of a multi-output child (DC-17)', () => {
  const [a, a2, b, c] = ['owner', 'owner-fix', 'api-consumer', 'web-consumer'].map(workId);
  const change = (owner: typeof a, name: string, revision: string) => ({
    name,
    reference: {
      workItemId: owner,
      resourceId: resId(name),
      repositoryResourceId: 'repo',
      revision: revision.repeat(40),
      branch: name,
      pullRequestBase: 'main',
      runId: 'run',
    },
  });
  const api = change(a!, 'api', '1');
  const web = change(a!, 'web', '2');
  const fixedApi = change(a2!, 'api', '3');
  const entry = (
    assignmentId: string,
    owner: typeof a,
    output: typeof api,
    replaces?: { childWorkItemId: typeof a; outputName: string },
  ) => ({
    cohortId: 'cohort',
    assignmentId,
    childWorkItemId: owner!,
    output,
    ...(replaces === undefined ? {} : { replaces }),
  });
  const consumer = (assignmentId: string, owner: typeof a) =>
    entry(assignmentId, owner, change(owner!, 'out', '4'));
  const before = {
    requestId: 'one',
    revision: 1,
    entries: [
      entry('api', a, api),
      entry('web', a, web),
      consumer('api-consumer', b),
      consumer('web-consumer', c),
    ],
  };
  const after = {
    requestId: 'two',
    revision: 2,
    entries: [
      entry('api', a2, fixedApi, { childWorkItemId: a, outputName: 'api' }),
      ...before.entries.slice(1),
    ],
  };
  const facts = {
    reservations: [],
    results: [
      { childWorkItemId: a, outputs: [api, web] },
      { childWorkItemId: a2, outputs: [fixedApi] },
    ],
    consumed: new Map([
      [b, [api]],
      [c, [web]],
    ]),
    selections: [before, after],
    candidates: [],
    qa: [],
    maintenance: [],
  };
  // The sibling web output and its consumer stay effective; only the api consumer is stale.
  expect([...staleEntries(facts as never)]).toEqual(['cohort/api-consumer/out']);
});
