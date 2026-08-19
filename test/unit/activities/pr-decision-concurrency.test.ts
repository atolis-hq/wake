import { expect, it } from 'vitest';
import { activityName } from '../../../src/activities/index.js';
import {
  orchestrationGroupId,
  signalName,
  workflowInstanceId,
} from '../../../src/orchestration/contracts/identifiers.js';
import { resourceCapability, resourceKind } from '../../../src/resources/index.js';
import { resId, workId } from '../../support/identities.js';

import {
  activationId,
  createPullRequestMergeActivity,
  type PullRequestAuthorityInput,
  type PullRequestService,
} from '../../../src/activities/index.js';
import { appendIntentOnce } from '../../../src/activities/pr/intent.js';
import type { EventDraft, EventJournal } from '../../../src/kernel/index.js';
import { type ResourceView } from '../../../src/resources/index.js';
import {} from '../../../src/work/index.js';
import { TestWorld } from '../../e2e/support/world.js';

it('atomically keeps one activation decision across interleaved authority evaluations', async () => {
  const world = new TestWorld();
  const interleaving = interleavingJournal(world.journal);
  const inputs = [authority('closed'), authority('open')];
  const service = authorityService(async () => inputs.shift()!);
  const activity = createPullRequestMergeActivity(interleaving.journal, service);
  const request = invocation();

  const first = activity.handler.execute(request, executionContext());
  await interleaving.deniedDecisionReached;
  const second = activity.handler.execute(request, executionContext());
  const outcomes = await Promise.all([first, second]);

  expect(outcomes).toEqual([
    {
      kind: 'waiting',
      data: {
        intentEventId: 'activation-1:pr.merge-requested',
        signalKind: signalName('delivery-result'),
      },
    },
    {
      kind: 'waiting',
      data: {
        intentEventId: 'activation-1:pr.merge-requested',
        signalKind: signalName('delivery-result'),
      },
    },
  ]);
  expect(await world.events('pr.merge-decision-claimed')).toEqual([
    expect.objectContaining({ payload: expect.objectContaining({ decisionKind: 'requested' }) }),
  ]);
  expect(await world.events('pr.merge-requested')).toHaveLength(1);
  expect(await world.events('pr.merge-denied')).toHaveLength(0);
  expect(interleaving.globalReads()).toBe(0);
});

it('resumes the claimed canonical fact after a crash without reevaluating authority', async () => {
  const world = new TestWorld();
  let authorityCalls = 0;
  const service = authorityService(async () => {
    authorityCalls += 1;
    return authority(authorityCalls === 1 ? 'open' : 'closed');
  });
  let crash = true;
  const activity = createPullRequestMergeActivity(world.journal, service, {
    async append(stream, event) {
      if (crash) {
        crash = false;
        throw new Error('simulated crash');
      }
      return appendIntentOnce(world.journal, stream, event);
    },
  });

  await expect(activity.handler.execute(invocation(), executionContext())).rejects.toThrow(
    'simulated crash',
  );
  expect(await world.events('pr.merge-decision-claimed')).toHaveLength(1);
  expect(await world.events('pr.merge-requested')).toHaveLength(0);

  await expect(activity.handler.execute(invocation(), executionContext())).resolves.toEqual({
    kind: 'waiting',
    data: {
      intentEventId: 'activation-1:pr.merge-requested',
      signalKind: signalName('delivery-result'),
    },
  });
  expect(authorityCalls).toBe(1);
  expect(await world.events('pr.merge-requested')).toHaveLength(1);
  expect(await world.events('pr.merge-denied')).toHaveLength(0);
});

function interleavingJournal(base: EventJournal) {
  let releaseDenied!: () => void;
  let signalDenied!: () => void;
  let globalReadCount = 0;
  const deniedDecisionReached = new Promise<void>((resolve) => {
    signalDenied = resolve;
  });
  const requestedDecisionWritten = new Promise<void>((resolve) => {
    releaseDenied = resolve;
  });
  const journal: EventJournal = {
    async append(stream, sequence, events) {
      const kind = decisionKind(events[0]);
      if (kind === 'denied') {
        signalDenied();
        await requestedDecisionWritten;
      }
      const appended = await base.append(stream, sequence, events);
      if (kind === 'requested') releaseDenied();
      return appended;
    },
    readStream: (stream) => base.readStream(stream),
    readAll(position, limit) {
      globalReadCount += 1;
      return base.readAll(position, limit);
    },
    latestGlobalPosition: base.latestGlobalPosition.bind(base),
    changeSignal: base.changeSignal,
  };
  return { journal, deniedDecisionReached, globalReads: () => globalReadCount };
}

function decisionKind(event: EventDraft | undefined): 'requested' | 'denied' | undefined {
  if (event?.eventType.endsWith('-decision-claimed')) {
    const payload = event.payload as { decisionKind?: 'requested' | 'denied' };
    return payload.decisionKind;
  }
  if (event?.eventType.endsWith('-requested')) return 'requested';
  if (event?.eventType.endsWith('-denied')) return 'denied';
  return undefined;
}

function authority(state: 'open' | 'closed'): PullRequestAuthorityInput {
  const resource = resId('1');
  const work = workId('1');
  return {
    work: {
      workItemId: work,
      objective: 'merge',
      state: 'open',
      tags: [],
      autoApprovalGranted: false,
      relatedWorkItems: [],
    },
    resources: [
      {
        resource: invocationResource(),
        correlations: [
          {
            resourceId: resource,
            workItemId: work,
            role: 'primary',
            provenance: 'provider-observed',
            establishedByEventId: 'correlation-1',
          },
        ],
      },
    ],
    pullRequests: [
      {
        resourceId: resource,
        workItemId: work,
        state,
        headRevision: 'head-a',
        baseRevision: 'base-a',
        checks: 'passing',
        acceptedReview: { revision: 'head-a', actorId: 'reviewer', acceptedEventId: 'review-1' },
      },
    ],
    acceptedSignals: [
      {
        resourceId: resource,
        revision: 'head-a',
        actorId: 'reviewer',
        actorKind: 'human',
        acceptedEventId: 'review-1',
        trusted: true,
      },
    ],
  };
}

function authorityService(load: () => Promise<PullRequestAuthorityInput>): PullRequestService {
  return { authorityInput: load } as unknown as PullRequestService;
}

function invocation() {
  return {
    activationId: activationId('activation-1'),
    activity: activityName('pr.merge'),
    workItemId: workId('1'),
    workflowInstanceId: workflowInstanceId('workflow-1'),
    orchestrationGroupId: orchestrationGroupId('group-1'),
    causationId: 'activation-1',
    input: {
      target: 'primary' as const,
      method: 'merge' as const,
      requireChecks: true,
      blockedPaths: [],
    },
    resources: [invocationResource()],
  };
}

function invocationResource(): ResourceView {
  return {
    resourceId: resId('1'),
    kind: resourceKind('pull-request'),
    externalKey: { adapter: 'neutral-test', key: 'pr-1' },
    capabilities: [
      resourceCapability('reviewable'),
      resourceCapability('mergeable'),
      resourceCapability('revisioned'),
    ],
  };
}

function executionContext() {
  return {
    occurredAt: '2026-07-30T12:10:00.000Z',
    signal: new AbortController().signal,
    async reportExternalExecution() {},
  };
}
