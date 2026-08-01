import { workId, resId } from '../../support/identities.js';
import { workflowName } from '../../../src-next/orchestration/contracts/identifiers.js';
import { resourceCapability, resourceKind } from '../../../src-next/resources/index.js';
import {
  createPullRequestApproveActivity,
  createPullRequestMergeActivity,
} from '../../../src-next/activities/index.js';
import type { ResourceCapability } from '../../../src-next/resources/index.js';
import { resourceId } from '../../../src-next/resources/index.js';
import { type WorkItemId } from '../../../src-next/work/index.js';
import { TestWorld } from '../support/world.js';

export type ApprovalScenario = 'missing' | 'capability-missing' | 'ambiguous' | 'conflict' | 'safe';

export type MergeScenario =
  | 'missing'
  | 'capability-missing'
  | 'ambiguous'
  | 'conflict'
  | 'closed'
  | 'stale'
  | 'unauthorized'
  | 'pending'
  | 'failing'
  | 'safe';

interface ScenarioSetup {
  readonly workItemId: WorkItemId;
  readonly primaryResourceId?: ReturnType<typeof resourceId>;
  readonly revision?: string;
}

export async function setupApprovalScenario(
  world: TestWorld,
  scenario: ApprovalScenario,
): Promise<ScenarioSetup> {
  const work = await world.createWork({
    objective: `approve ${scenario}`,
    workItemId: workId('one'),
  });
  if (scenario === 'missing') return { workItemId: work.workItemId };
  const primaryCapabilities: readonly ResourceCapability[] =
    scenario === 'capability-missing'
      ? [resourceCapability('reviewable'), resourceCapability('revisioned')]
      : [
          resourceCapability('reviewable'),
          resourceCapability('approvable'),
          resourceCapability('revisioned'),
        ];
  const primary = await addObservedPullRequest(world, {
    work: work.workItemId,
    suffix: 'primary',
    capabilities: primaryCapabilities,
  });
  if (scenario === 'capability-missing' || scenario === 'safe') {
    await addResource(world, work.workItemId, 'secondary', 'secondary', [
      resourceCapability('reviewable'),
      resourceCapability('approvable'),
      resourceCapability('revisioned'),
    ]);
  }
  if (scenario === 'ambiguous') {
    await addObservedPullRequest(world, {
      work: work.workItemId,
      suffix: 'other-primary',
      capabilities: [
        resourceCapability('reviewable'),
        resourceCapability('approvable'),
        resourceCapability('revisioned'),
      ],
    });
  }
  if (scenario === 'conflict') await recordCorrelationConflict(world, primary);
  return { workItemId: work.workItemId, primaryResourceId: primary, revision: 'revision-a' };
}

export async function setupMergeScenario(
  world: TestWorld,
  scenario: MergeScenario,
): Promise<ScenarioSetup> {
  const work = await world.createWork({
    objective: `merge ${scenario}`,
    workItemId: workId('one'),
  });
  if (scenario === 'missing') return { workItemId: work.workItemId };
  const primaryCapabilities: readonly ResourceCapability[] =
    scenario === 'capability-missing'
      ? [resourceCapability('reviewable'), resourceCapability('revisioned')]
      : [
          resourceCapability('reviewable'),
          resourceCapability('mergeable'),
          resourceCapability('revisioned'),
        ];
  const primary = await addObservedPullRequest(world, {
    work: work.workItemId,
    suffix: 'primary',
    capabilities: primaryCapabilities,
    state: scenario === 'closed' ? 'closed' : 'open',
    checks: scenario === 'pending' ? 'pending' : scenario === 'failing' ? 'failing' : 'passing',
  });
  if (scenario === 'capability-missing' || scenario === 'safe') {
    await addResource(world, work.workItemId, 'secondary', 'secondary', [
      resourceCapability('reviewable'),
      resourceCapability('mergeable'),
      resourceCapability('revisioned'),
    ]);
  }
  if (scenario === 'ambiguous') {
    const other = await addObservedPullRequest(world, {
      work: work.workItemId,
      suffix: 'other-primary',
      capabilities: [
        resourceCapability('reviewable'),
        resourceCapability('mergeable'),
        resourceCapability('revisioned'),
      ],
    });
    await acceptReview(world, other, 'reviewer-2', true);
  }
  await acceptReview(world, primary, 'reviewer', scenario !== 'unauthorized');
  if (scenario === 'stale') {
    await world.pullRequests.observe(
      {
        resourceId: primary,
        workItemId: work.workItemId,
        state: 'open',
        headRevision: 'revision-b',
        baseRevision: 'base-a',
        checks: 'passing',
      },
      command(world, 'observe-stale'),
    );
  }
  if (scenario === 'conflict') await recordCorrelationConflict(world, primary);
  return {
    workItemId: work.workItemId,
    primaryResourceId: primary,
    revision: scenario === 'stale' ? 'revision-b' : 'revision-a',
  };
}

export async function executeApproval(world: TestWorld, work: WorkItemId) {
  world.registerActivity(createPullRequestApproveActivity(world.journal, world.pullRequests));
  world.configureWorkflow('approve', {
    stages: {
      approve: {
        activity: 'pr.approve',
        with: { body: 'Reviewed' },
        on: outcomeRoutes(),
      },
    },
  });
  const workflow = await world.startWorkflow({
    workItemId: work,
    workflowName: workflowName('approve'),
  });
  await world.advance(work);
  return workflow.workflowInstanceId;
}

export async function executeMerge(
  world: TestWorld,
  work: WorkItemId,
  target?: 'primary' | { readonly resourceId: string },
) {
  world.registerActivity(createPullRequestMergeActivity(world.journal, world.pullRequests));
  world.configureWorkflow('merge', {
    stages: {
      merge: {
        activity: 'pr.merge',
        with: {
          ...(target === undefined ? {} : { target }),
          method: 'squash',
          requireChecks: true,
        },
        on: outcomeRoutes(),
      },
    },
  });
  const workflow = await world.startWorkflow({
    workItemId: work,
    workflowName: workflowName('merge'),
  });
  await world.advance(work);
  return workflow.workflowInstanceId;
}

async function addObservedPullRequest(
  world: TestWorld,
  input: {
    readonly work: WorkItemId;
    readonly suffix: string;
    readonly capabilities: readonly ResourceCapability[];
    readonly state?: 'open' | 'closed';
    readonly checks?: 'pending' | 'passing' | 'failing';
  },
) {
  const resource = await addResource(
    world,
    input.work,
    input.suffix,
    'primary',
    input.capabilities,
  );
  await world.pullRequests.observe(
    {
      resourceId: resource,
      workItemId: input.work,
      state: input.state ?? 'open',
      headRevision: 'revision-a',
      baseRevision: 'base-a',
      checks: input.checks ?? 'passing',
    },
    command(world, `observe-${input.suffix}`),
  );
  return resource;
}

async function addResource(
  world: TestWorld,
  work: WorkItemId,
  suffix: string,
  role: 'primary' | 'secondary',
  capabilities: readonly ResourceCapability[],
) {
  const resource = resId(suffix);
  await world.discoverResource({
    resourceId: resource,
    kind: resourceKind('pull-request'),
    externalKey: { adapter: 'neutral-test', key: `pr-${suffix}` },
    capabilities,
  });
  await world.resources.correlate(resource, work, role, command(world, `correlate-${suffix}`));
  return resource;
}

async function acceptReview(
  world: TestWorld,
  resource: ReturnType<typeof resourceId>,
  actorId: string,
  authorized: boolean,
) {
  await world.pullRequests.acceptReviewSignal(
    {
      resourceId: resource,
      revision: 'revision-a',
      actorId,
      actorKind: 'human',
      acceptedEventId: `review-${actorId}`,
      resourceAuthorId: 'author',
      authorization: {
        source: 'configured-reviewer',
        reviewerId: authorized ? actorId : 'different-reviewer',
      },
    },
    command(world, `accept-${actorId}`),
  );
}

async function recordCorrelationConflict(
  world: TestWorld,
  resource: ReturnType<typeof resourceId>,
) {
  await expectRejection(
    world.resources.correlate(
      resource,
      workId('conflicting'),
      'primary',
      command(world, 'conflict'),
    ),
  );
}

async function expectRejection(operation: Promise<unknown>): Promise<void> {
  try {
    await operation;
  } catch {
    return;
  }
  throw new Error('Expected correlation conflict');
}

function command(world: TestWorld, commandId: string) {
  return {
    commandId,
    correlationId: 'scenario-1' as never,
    occurredAt: world.clock.now().toISOString(),
    actor: { kind: 'system' as const, id: 'test' },
  };
}

function outcomeRoutes() {
  return {
    waiting: { then: 'await-human' },
    blocked: { then: 'await-human' },
    failed: { then: 'await-human' },
    done: { then: 'done' },
  };
}
