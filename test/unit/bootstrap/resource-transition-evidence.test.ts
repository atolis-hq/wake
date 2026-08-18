import { expect, it } from 'vitest';
import {
  ActivityEventType,
  PullRequestCheckState,
  PullRequestState,
  type PullRequestAuthorityInput,
  type PullRequestService,
} from '../../../src/activities/index.js';
import { createCapabilityResourceTransitionEvidence } from '../../../src/bootstrap/index.js';
import {
  createPullRequestTransitionEvidence,
  TransitionTargetKind,
  type CompiledResourceTransition,
  type ResourceTransitionEvidence,
} from '../../../src/orchestration/index.js';
import {
  BuiltInResourceCapability,
  resourceStream,
  type ResourceService,
} from '../../../src/resources/index.js';
import { workItemId } from '../../../src/work/index.js';
import { eventEnvelope } from '../../support/event-envelope.js';
import { resId } from '../../support/identities.js';

const workItem = workItemId('work-00000000000000000000000001');
const pullRequestResource = resId('pull-request');
const completableResource = resId('completable');
const transition: CompiledResourceTransition = {
  event: ActivityEventType.PrStateChanged,
  where: { state: PullRequestState.Merged },
  target: { kind: TransitionTargetKind.Complete },
};

it('resolves through the matching primary when another primary resource does not match any policy', async () => {
  let pullRequestPolicyCalls = 0;
  const fact = eventEnvelope(
    ActivityEventType.PrStateChanged,
    { state: PullRequestState.Merged },
    resourceStream(pullRequestResource),
  );
  const pullRequestPolicy = createPullRequestTransitionEvidence({
    async authorityInput(): Promise<PullRequestAuthorityInput> {
      pullRequestPolicyCalls += 1;
      return {
        work: null,
        resources: [
          {
            resource: {
              resourceId: pullRequestResource,
              kind: 'pull-request' as never,
              externalKey: { adapter: 'test', key: '1' },
              capabilities: [BuiltInResourceCapability.Reviewable],
            },
            correlations: [
              {
                resourceId: pullRequestResource,
                workItemId: workItem,
                role: 'primary',
                provenance: 'provider-observed',
                establishedByEventId: 'correlation-1',
              },
            ],
          },
        ],
        pullRequests: [
          {
            resourceId: pullRequestResource,
            workItemId: workItem,
            state: PullRequestState.Merged,
            headRevision: 'head-a',
            baseRevision: 'base-a',
            checks: PullRequestCheckState.Passing,
          },
        ],
        acceptedSignals: [],
      };
    },
    async factsFor() {
      return [fact];
    },
  } as unknown as PullRequestService);
  const resources = {
    async correlationsForWork() {
      return [
        {
          resourceId: pullRequestResource,
          workItemId: workItem,
          role: 'primary',
          provenance: 'provider-observed',
          establishedByEventId: 'correlation-pr',
        },
        {
          resourceId: completableResource,
          workItemId: workItem,
          role: 'primary',
          provenance: 'provider-observed',
          establishedByEventId: 'correlation-issue',
        },
      ];
    },
    async get(resourceId: typeof pullRequestResource) {
      return resourceId === pullRequestResource
        ? {
            resourceId: pullRequestResource,
            kind: 'pull-request' as never,
            externalKey: { adapter: 'test', key: '1' },
            capabilities: [BuiltInResourceCapability.Reviewable],
          }
        : {
            resourceId: completableResource,
            kind: 'issue' as never,
            externalKey: { adapter: 'test', key: '2' },
            capabilities: [BuiltInResourceCapability.Completable],
          };
    },
  } as unknown as ResourceService;
  const evidence = createCapabilityResourceTransitionEvidence({
    resources,
    policies: [
      {
        capabilities: [
          BuiltInResourceCapability.Mergeable,
          BuiltInResourceCapability.Reviewable,
          BuiltInResourceCapability.Approvable,
        ],
        policy: pullRequestPolicy,
      },
    ],
  });

  const resolved = await evidence.resolve({
    workItemId: workItem,
    transitions: [transition],
    fact,
  });

  expect(evidence.triggers).toEqual([
    ActivityEventType.PrReviewAccepted,
    ActivityEventType.PrStateChanged,
    ActivityEventType.PrChecksChanged,
  ]);
  expect(resolved).toEqual({ transition, evidenceId: fact.eventId });
  expect(pullRequestPolicyCalls).toBe(1);
});

it('fails closed without invoking policies when two primary resources each match a policy', async () => {
  let pullRequestPolicyCalls = 0;
  let completablePolicyCalls = 0;
  const fact = eventEnvelope(
    ActivityEventType.PrStateChanged,
    { state: PullRequestState.Merged },
    resourceStream(pullRequestResource),
  );
  const pullRequestPolicy: ResourceTransitionEvidence = {
    triggers: [ActivityEventType.PrStateChanged],
    async resolve() {
      pullRequestPolicyCalls += 1;
      return null;
    },
  };
  const completablePolicy: ResourceTransitionEvidence = {
    triggers: ['issue.completed'],
    async resolve() {
      completablePolicyCalls += 1;
      return null;
    },
  };
  const resources = {
    async correlationsForWork() {
      return [
        {
          resourceId: pullRequestResource,
          workItemId: workItem,
          role: 'primary',
          provenance: 'provider-observed',
          establishedByEventId: 'correlation-pr',
        },
        {
          resourceId: completableResource,
          workItemId: workItem,
          role: 'primary',
          provenance: 'provider-observed',
          establishedByEventId: 'correlation-issue',
        },
      ];
    },
    async get(resourceId: typeof pullRequestResource) {
      return resourceId === pullRequestResource
        ? {
            resourceId: pullRequestResource,
            kind: 'pull-request' as never,
            externalKey: { adapter: 'test', key: '1' },
            capabilities: [BuiltInResourceCapability.Reviewable],
          }
        : {
            resourceId: completableResource,
            kind: 'issue' as never,
            externalKey: { adapter: 'test', key: '2' },
            capabilities: [BuiltInResourceCapability.Completable],
          };
    },
  } as unknown as ResourceService;
  const evidence = createCapabilityResourceTransitionEvidence({
    resources,
    policies: [
      {
        capabilities: [
          BuiltInResourceCapability.Mergeable,
          BuiltInResourceCapability.Reviewable,
          BuiltInResourceCapability.Approvable,
        ],
        policy: pullRequestPolicy,
      },
      { capabilities: [BuiltInResourceCapability.Completable], policy: completablePolicy },
    ],
  });

  const resolved = await evidence.resolve({
    workItemId: workItem,
    transitions: [transition],
    fact,
  });

  expect(resolved).toBeNull();
  expect(pullRequestPolicyCalls).toBe(0);
  expect(completablePolicyCalls).toBe(0);
});

it('fails closed without invoking policies when work has no primary resource', async () => {
  let policyCalls = 0;
  const evidence = createCapabilityResourceTransitionEvidence({
    resources: {
      async correlationsForWork() {
        return [];
      },
    } as unknown as ResourceService,
    policies: [
      {
        capabilities: [BuiltInResourceCapability.Completable],
        policy: {
          triggers: ['issue.completed'],
          async resolve() {
            policyCalls += 1;
            return null;
          },
        },
      },
    ],
  });

  await expect(
    evidence.resolve({ workItemId: workItem, transitions: [transition] }),
  ).resolves.toBeNull();
  expect(policyCalls).toBe(0);
});

it('does not invoke the pull-request policy for a completable resource', async () => {
  let pullRequestPolicyCalls = 0;
  let completablePolicyCalls = 0;
  const matchingFact = eventEnvelope(
    ActivityEventType.PrStateChanged,
    { state: PullRequestState.Merged },
    resourceStream(completableResource),
  );
  const unrelatedFact = eventEnvelope(
    ActivityEventType.PrChecksChanged,
    { checks: PullRequestCheckState.Passing },
    resourceStream(completableResource),
    8,
  );
  const pullRequestPolicy = createPullRequestTransitionEvidence({
    async authorityInput(): Promise<PullRequestAuthorityInput> {
      pullRequestPolicyCalls += 1;
      throw new Error('pull-request policy must not be selected');
    },
    async factsFor() {
      return [];
    },
  } as unknown as PullRequestService);
  const completablePolicy: ResourceTransitionEvidence = {
    triggers: ['issue.completed'],
    async resolve(input) {
      completablePolicyCalls += 1;
      const transition = input.transitions.find(
        (candidate) => candidate.event === input.fact?.eventType,
      );
      return transition === undefined || input.fact === undefined
        ? null
        : { transition, evidenceId: input.fact.eventId };
    },
  };
  const evidence = createCapabilityResourceTransitionEvidence({
    resources: {
      async correlationsForWork() {
        return [
          {
            resourceId: completableResource,
            workItemId: workItem,
            role: 'primary',
            provenance: 'provider-observed',
            establishedByEventId: 'correlation-issue',
          },
        ];
      },
      async get() {
        return {
          resourceId: completableResource,
          kind: 'issue' as never,
          externalKey: { adapter: 'test', key: '2' },
          capabilities: [BuiltInResourceCapability.Completable],
        };
      },
    } as unknown as ResourceService,
    policies: [
      {
        capabilities: [
          BuiltInResourceCapability.Mergeable,
          BuiltInResourceCapability.Reviewable,
          BuiltInResourceCapability.Approvable,
        ],
        policy: pullRequestPolicy,
      },
      { capabilities: [BuiltInResourceCapability.Completable], policy: completablePolicy },
    ],
  });

  await expect(
    evidence.resolve({ workItemId: workItem, transitions: [transition], fact: matchingFact }),
  ).resolves.toEqual({
    transition,
    evidenceId: matchingFact.eventId,
  });
  await expect(
    evidence.resolve({ workItemId: workItem, transitions: [transition], fact: unrelatedFact }),
  ).resolves.toBeNull();
  expect(pullRequestPolicyCalls).toBe(0);
  expect(completablePolicyCalls).toBe(2);
});
