import { describe, expect, it } from 'vitest';
import {
  ActivityEventType,
  createPullRequestService,
  PullRequestCheckState,
  PullRequestState,
  type PullRequestService,
} from '../../../src/activities/index.js';
import { correlationId, type EventEnvelope } from '../../../src/kernel/index.js';
import {
  createPullRequestTransitionEvidence,
  TransitionTargetKind,
  type CompiledResourceTransition,
} from '../../../src/orchestration/index.js';
import { InMemoryEventJournal } from '../../../src/persistence/index.js';
import { resourceCapability, resourceKind, resourceStream } from '../../../src/resources/index.js';
import { createWorkService } from '../../../src/work/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { resId, workId } from '../../support/identities.js';
import { createTestResourceServices } from '../../support/resource-lookup.js';

const workItemId = workId('1');
const resource = resId('1');
const otherWorkItemId = workId('2');
const otherResource = resId('2');

const mergedTransition: CompiledResourceTransition = {
  event: ActivityEventType.PrStateChanged,
  where: { state: PullRequestState.Merged },
  target: { kind: TransitionTargetKind.Complete },
};

const approvalTransition: CompiledResourceTransition = {
  event: ActivityEventType.PrReviewAccepted,
  target: { kind: TransitionTargetKind.Complete },
};

const checksTransition: CompiledResourceTransition = {
  event: ActivityEventType.PrChecksChanged,
  where: { checks: PullRequestCheckState.Failing },
  target: { kind: TransitionTargetKind.Complete },
};

function context(commandId: string) {
  return {
    commandId,
    correlationId: correlationId('correlation-1'),
    occurredAt: '2026-07-30T12:00:00.000Z',
    actor: { kind: 'integration' as const, id: 'github' },
  };
}

async function setup() {
  const journal = new InMemoryEventJournal(new FakeClock());
  const { resources } = createTestResourceServices(journal);
  const work = createWorkService(journal);
  await work.create({ workItemId, objective: 'Merge PR' }, context('work'));
  await resources.discover(
    {
      resourceId: resource,
      kind: resourceKind('pull-request'),
      externalKey: { adapter: 'github', key: 'o/r#1' },
      capabilities: [resourceCapability('reviewable'), resourceCapability('revisioned')],
    },
    context('resource'),
  );
  await resources.correlate(resource, workItemId, 'primary', context('correlation'));
  const pullRequests = createPullRequestService(journal, work, resources);
  return { journal, resources, work, pullRequests };
}

async function factOfType(
  pullRequests: PullRequestService,
  eventType: string,
): Promise<EventEnvelope> {
  const events = await pullRequests.factsFor(resource);
  const fact = events.find((event) => event.eventType === eventType);
  if (fact === undefined) throw new Error(`No ${eventType} fact recorded`);
  return fact;
}

describe('createPullRequestTransitionEvidence', () => {
  it('confirms a merged fact about this work item primary pull request', async () => {
    const { pullRequests } = await setup();
    await pullRequests.observe(
      {
        resourceId: resource,
        workItemId,
        state: 'open',
        headRevision: 'head-a',
        baseRevision: 'base-a',
        checks: 'passing',
      },
      context('observe-a'),
    );
    await pullRequests.observe(
      {
        resourceId: resource,
        workItemId,
        state: 'merged',
        headRevision: 'head-a',
        baseRevision: 'base-a',
        checks: 'passing',
      },
      context('observe-merged'),
    );
    const mergedFact = await factOfType(pullRequests, ActivityEventType.PrStateChanged);

    const evidence = createPullRequestTransitionEvidence(pullRequests);
    const resolved = await evidence.resolve({
      workItemId,
      transitions: [mergedTransition],
      fact: mergedFact,
    });

    expect(resolved?.evidenceId).toBe(mergedFact.eventId);
    expect(resolved?.transition).toBe(mergedTransition);
  });

  it('rejects a fact about another work item resource', async () => {
    const { journal, resources, work, pullRequests } = await setup();
    await work.create(
      { workItemId: otherWorkItemId, objective: 'Unrelated PR' },
      context('other-work'),
    );
    await resources.discover(
      {
        resourceId: otherResource,
        kind: resourceKind('pull-request'),
        externalKey: { adapter: 'github', key: 'o/r#2' },
        capabilities: [resourceCapability('reviewable'), resourceCapability('revisioned')],
      },
      context('other-resource'),
    );
    await resources.correlate(
      otherResource,
      otherWorkItemId,
      'primary',
      context('other-correlation'),
    );
    await pullRequests.observe(
      {
        resourceId: otherResource,
        workItemId: otherWorkItemId,
        state: 'open',
        headRevision: 'head-x',
        baseRevision: 'base-x',
        checks: 'passing',
      },
      context('observe-other-open'),
    );
    await pullRequests.observe(
      {
        resourceId: otherResource,
        workItemId: otherWorkItemId,
        state: 'merged',
        headRevision: 'head-x',
        baseRevision: 'base-x',
        checks: 'passing',
      },
      context('observe-other-merged'),
    );
    const otherResourceFact = (await journal.readStream(resourceStream(otherResource))).find(
      (event) => event.eventType === ActivityEventType.PrStateChanged,
    );
    if (otherResourceFact === undefined) throw new Error('No pr.state-changed fact recorded');

    // setup() already discovered and primary-correlated `resource` to
    // `workItemId`. Merge this work item's own PR too, so the merged-state
    // clause of the matcher can't be what rejects the foreign fact — only
    // the scoping check (the foreign fact's stream isn't this resource) can.
    await pullRequests.observe(
      {
        resourceId: resource,
        workItemId,
        state: 'open',
        headRevision: 'head-a',
        baseRevision: 'base-a',
        checks: 'passing',
      },
      context('observe-a'),
    );
    await pullRequests.observe(
      {
        resourceId: resource,
        workItemId,
        state: 'merged',
        headRevision: 'head-a',
        baseRevision: 'base-a',
        checks: 'passing',
      },
      context('observe-merged'),
    );

    const evidence = createPullRequestTransitionEvidence(pullRequests);
    expect(
      await evidence.resolve({
        workItemId,
        transitions: [mergedTransition],
        fact: otherResourceFact,
      }),
    ).toBeNull();
  });

  it('rejects a merged fact when the pull request is no longer merged', async () => {
    const { pullRequests } = await setup();
    await pullRequests.observe(
      {
        resourceId: resource,
        workItemId,
        state: 'open',
        headRevision: 'head-a',
        baseRevision: 'base-a',
        checks: 'passing',
      },
      context('observe-a'),
    );
    await pullRequests.observe(
      {
        resourceId: resource,
        workItemId,
        state: 'merged',
        headRevision: 'head-a',
        baseRevision: 'base-a',
        checks: 'passing',
      },
      context('observe-merged'),
    );
    const mergedFact = await factOfType(pullRequests, ActivityEventType.PrStateChanged);

    // Observe the provider re-opening the PR after the merged fact was recorded.
    await pullRequests.observe(
      {
        resourceId: resource,
        workItemId,
        state: 'open',
        headRevision: 'head-a',
        baseRevision: 'base-a',
        checks: 'passing',
      },
      context('observe-reopened'),
    );

    const evidence = createPullRequestTransitionEvidence(pullRequests);
    expect(
      await evidence.resolve({
        workItemId,
        transitions: [mergedTransition],
        fact: mergedFact,
      }),
    ).toBeNull();
  });

  it('recalls a durable merged fact when no fact is supplied', async () => {
    const { pullRequests } = await setup();
    await pullRequests.observe(
      {
        resourceId: resource,
        workItemId,
        state: 'open',
        headRevision: 'head-a',
        baseRevision: 'base-a',
        checks: 'passing',
      },
      context('observe-a'),
    );
    await pullRequests.observe(
      {
        resourceId: resource,
        workItemId,
        state: 'merged',
        headRevision: 'head-a',
        baseRevision: 'base-a',
        checks: 'passing',
      },
      context('observe-merged'),
    );
    const mergedFact = await factOfType(pullRequests, ActivityEventType.PrStateChanged);

    const evidence = createPullRequestTransitionEvidence(pullRequests);
    const resolved = await evidence.resolve({ workItemId, transitions: [mergedTransition] });

    expect(resolved?.evidenceId).toBe(mergedFact.eventId);
  });

  it('confirms a trusted accepted review at the current head revision', async () => {
    const { pullRequests } = await setup();
    await pullRequests.observe(
      {
        resourceId: resource,
        workItemId,
        state: 'open',
        headRevision: 'head-a',
        baseRevision: 'base-a',
        checks: 'passing',
      },
      context('observe-a'),
    );
    await pullRequests.acceptReviewSignal(
      {
        resourceId: resource,
        revision: 'head-a',
        actorId: 'reviewer',
        actorKind: 'human',
        acceptedEventId: 'review-a',
        resourceAuthorId: 'author',
        authorization: { source: 'configured-reviewer', reviewerId: 'reviewer' },
      },
      context('review-a'),
    );
    const acceptedFact = await factOfType(pullRequests, ActivityEventType.PrReviewAccepted);

    const evidence = createPullRequestTransitionEvidence(pullRequests);
    const resolved = await evidence.resolve({
      workItemId,
      transitions: [approvalTransition],
      fact: acceptedFact,
    });

    expect(resolved?.evidenceId).toBe(acceptedFact.eventId);
  });

  it('rejects an approval that has since been revoked', async () => {
    const { pullRequests } = await setup();
    await pullRequests.observe(
      {
        resourceId: resource,
        workItemId,
        state: 'open',
        headRevision: 'head-a',
        baseRevision: 'base-a',
        checks: 'passing',
      },
      context('observe-a'),
    );
    await pullRequests.acceptReviewSignal(
      {
        resourceId: resource,
        revision: 'head-a',
        actorId: 'reviewer',
        actorKind: 'human',
        acceptedEventId: 'review-a',
        resourceAuthorId: 'author',
        authorization: { source: 'configured-reviewer', reviewerId: 'reviewer' },
      },
      context('review-a'),
    );
    const revokedApproval = await factOfType(pullRequests, ActivityEventType.PrReviewAccepted);

    // Head stays at head-a — only the review authority changes, via a
    // requested-changes signal at the same revision, which clears
    // acceptedReview. This isolates the `decideAuthority` guard: nothing
    // about the fact's own revision changed, so if the guard were skipped
    // (or hard-coded to `true`), this stale approval would still resolve.
    await pullRequests.requestChangesSignal(
      {
        resourceId: resource,
        revision: 'head-a',
        actorId: 'author',
        requestedEventId: 'changes-a',
      },
      context('changes-a'),
    );

    const evidence = createPullRequestTransitionEvidence(pullRequests);
    expect(
      await evidence.resolve({
        workItemId,
        transitions: [approvalTransition],
        fact: revokedApproval,
      }),
    ).toBeNull();
  });

  it('rejects a superseded review-accepted event even when the PR is currently authorized', async () => {
    const { pullRequests } = await setup();
    await pullRequests.observe(
      {
        resourceId: resource,
        workItemId,
        state: 'open',
        headRevision: 'head-a',
        baseRevision: 'base-a',
        checks: 'passing',
      },
      context('observe-a'),
    );
    await pullRequests.acceptReviewSignal(
      {
        resourceId: resource,
        revision: 'head-a',
        actorId: 'reviewer',
        actorKind: 'human',
        acceptedEventId: 'review-a',
        resourceAuthorId: 'author',
        authorization: { source: 'configured-reviewer', reviewerId: 'reviewer' },
      },
      context('review-a'),
    );
    const supersededApproval = await factOfType(pullRequests, ActivityEventType.PrReviewAccepted);

    // A new revision lands and is freshly re-approved, so the PR is
    // currently authorized again — but not by the earlier event.
    await pullRequests.observe(
      {
        resourceId: resource,
        workItemId,
        state: 'open',
        headRevision: 'head-b',
        baseRevision: 'base-a',
        checks: 'passing',
      },
      context('observe-b'),
    );
    await pullRequests.acceptReviewSignal(
      {
        resourceId: resource,
        revision: 'head-b',
        actorId: 'reviewer',
        actorKind: 'human',
        acceptedEventId: 'review-b',
        resourceAuthorId: 'author',
        authorization: { source: 'configured-reviewer', reviewerId: 'reviewer' },
      },
      context('review-b'),
    );

    const evidence = createPullRequestTransitionEvidence(pullRequests);
    expect(
      await evidence.resolve({
        workItemId,
        transitions: [approvalTransition],
        fact: supersededApproval,
      }),
    ).toBeNull();
  });

  it('rejects an approval once the pull request is no longer open', async () => {
    const { pullRequests } = await setup();
    await pullRequests.observe(
      {
        resourceId: resource,
        workItemId,
        state: 'open',
        headRevision: 'head-a',
        baseRevision: 'base-a',
        checks: 'passing',
      },
      context('observe-a'),
    );
    await pullRequests.acceptReviewSignal(
      {
        resourceId: resource,
        revision: 'head-a',
        actorId: 'reviewer',
        actorKind: 'human',
        acceptedEventId: 'review-a',
        resourceAuthorId: 'author',
        authorization: { source: 'configured-reviewer', reviewerId: 'reviewer' },
      },
      context('review-a'),
    );
    const acceptedFact = await factOfType(pullRequests, ActivityEventType.PrReviewAccepted);

    // The PR is merged after the review was accepted; decidePullRequestAuthority
    // denies on state !== Open (policy.ts) before it even reaches the review check.
    await pullRequests.observe(
      {
        resourceId: resource,
        workItemId,
        state: 'merged',
        headRevision: 'head-a',
        baseRevision: 'base-a',
        checks: 'passing',
      },
      context('observe-merged'),
    );

    const evidence = createPullRequestTransitionEvidence(pullRequests);
    expect(
      await evidence.resolve({
        workItemId,
        transitions: [approvalTransition],
        fact: acceptedFact,
      }),
    ).toBeNull();
  });

  it('confirms a checks-failing fact against its checks transition', async () => {
    const { pullRequests } = await setup();
    await pullRequests.observe(
      {
        resourceId: resource,
        workItemId,
        state: 'open',
        headRevision: 'head-a',
        baseRevision: 'base-a',
        checks: 'passing',
      },
      context('observe-a'),
    );
    await pullRequests.observe(
      {
        resourceId: resource,
        workItemId,
        state: 'open',
        headRevision: 'head-a',
        baseRevision: 'base-a',
        checks: 'failing',
      },
      context('observe-failing'),
    );
    const failingFact = await factOfType(pullRequests, ActivityEventType.PrChecksChanged);

    const evidence = createPullRequestTransitionEvidence(pullRequests);
    const resolved = await evidence.resolve({
      workItemId,
      transitions: [checksTransition],
      fact: failingFact,
    });

    expect(resolved?.evidenceId).toBe(failingFact.eventId);
  });
});
