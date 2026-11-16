import { expect, it } from 'vitest';
import {
  ActivityEventType,
  PullRequestCheckState,
  PullRequestState,
} from '../../../src/activities/index.js';
import {
  createPullRequestTransitionEvidence,
  stageName,
  TransitionTargetKind,
  type CompiledResourceTransition,
} from '../../../src/orchestration/index.js';
import {
  BuiltInResourceCapability,
  resourceKind,
  resourceStream,
} from '../../../src/resources/index.js';
import { TestWorld } from '../../e2e/support/world.js';
import { eventEnvelope } from '../../support/event-envelope.js';
import { resId } from '../../support/identities.js';

it('requires current-head evidence for live and recovered bounded failures, preserving legacy routes', async () => {
  const world = new TestWorld();
  const work = await world.createWork({ objective: 'repair checks' });
  const resourceId = resId('check-evidence');
  await world.discoverResource({
    resourceId,
    kind: resourceKind('pull-request'),
    externalKey: { adapter: 'fake', key: 'checks' },
    capabilities: [BuiltInResourceCapability.Mergeable],
  });
  await world.correlateResource(resourceId, work.workItemId, 'primary');
  const observation = {
    resourceId,
    workItemId: work.workItemId,
    state: PullRequestState.Open,
    headRevision: 'old',
    baseRevision: 'base',
    checks: PullRequestCheckState.Failing,
  };
  await world.observePullRequest({ ...observation, checks: PullRequestCheckState.Passing });
  await world.observePullRequest(observation);
  const fact = (await world.pullRequests.factsFor(resourceId)).find(
    (event) => event.event.eventType === ActivityEventType.PrChecksChanged,
  )!;
  const transition: CompiledResourceTransition = {
    event: ActivityEventType.PrChecksChanged,
    where: { checks: PullRequestCheckState.Failing },
    target: { kind: TransitionTargetKind.Stage, stage: stageName('repair') },
    retry: { max: 2 },
  };
  const policy = createPullRequestTransitionEvidence(world.pullRequests, async () => [
    'integration',
  ]);
  const input = { workItemId: work.workItemId, transitions: [transition] };
  expect(await policy.resolve({ ...input, fact })).toMatchObject({
    failingCheckNames: ['integration'],
  });
  const legacyFact = eventEnvelope(
    ActivityEventType.PrChecksChanged,
    { checks: PullRequestCheckState.Failing },
    resourceStream(resourceId),
  );
  expect(await policy.resolve({ ...input, fact: legacyFact })).toBeNull();
  await world.observePullRequest({ ...observation, headRevision: 'new' });
  expect(await policy.resolve({ ...input, fact })).toBeNull();
  expect(await policy.resolve(input)).not.toBeNull();
  const { retry: _retry, ...legacy } = transition;
  expect(await policy.resolve({ ...input, transitions: [legacy], fact })).not.toBeNull();
  await world.observePullRequest({
    ...observation,
    headRevision: 'new',
  });
  expect(await policy.resolve(input)).toMatchObject({ failingCheckNames: ['integration'] });
  await world.observePullRequest({ ...observation, state: PullRequestState.Merged });
  expect(await policy.resolve(input)).toBeNull();
});
