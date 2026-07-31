import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  activationId,
  activityDecisionStream,
  ActivityStreamKind,
  type ActivationId,
  type PrAction,
} from '../../src-next/activities/index.js';
import {
  ExecutionStreamKind,
  runId,
  runStream,
  type RunId,
} from '../../src-next/execution/index.js';
import {
  adapterId,
  BuiltInAdapterId,
  GitHubAdapterId,
  integrationStream,
  IntegrationStreamKind,
  type AdapterId,
} from '../../src-next/integrations/index.js';
import type { EntityRef } from '../../src-next/kernel/index.js';
import {
  childOrchestrationGroupStream,
  OrchestrationStreamKind,
  primaryOrchestrationGroupStream,
  workflowInstanceId,
  workflowInstanceStream,
} from '../../src-next/orchestration/index.js';
import {
  resourceId,
  resourceStream,
  ResourceStreamKind,
  type ResourceId,
} from '../../src-next/resources/index.js';
import {
  isWorkItemStream,
  workItemId,
  workItemStream,
  WorkStreamKind,
  type WorkItemId,
} from '../../src-next/work/index.js';

describe('domain-owned logical streams', () => {
  it('preserves the WorkItem stream kind and branded id types', () => {
    const id = workItemId('work-1');
    const stream = workItemStream(id);

    expect(stream).toEqual({ kind: 'work-item', id });
    expect(isWorkItemStream(stream)).toBe(true);
    expectTypeOf(stream).toEqualTypeOf<EntityRef<typeof WorkStreamKind.WorkItem, WorkItemId>>();
    expectTypeOf(workItemStream).parameter(0).toEqualTypeOf<WorkItemId>();
  });

  it('constructs Resource streams through the Resources contract', () => {
    const id = resourceId('resource-1');
    const stream = resourceStream(id);

    expect(stream).toEqual({ kind: ResourceStreamKind.Resource, id });
    expectTypeOf(stream.id).toEqualTypeOf<ResourceId>();
  });

  it('constructs Run streams through the Execution contract', () => {
    const id = runId('run-1');
    const stream = runStream(id);

    expect(stream).toEqual({ kind: ExecutionStreamKind.Run, id });
    expectTypeOf(stream.id).toEqualTypeOf<RunId>();
  });

  it('constructs WorkflowInstance and coordination streams through Orchestration', () => {
    const workflowId = workflowInstanceId('workflow-1');
    const workflowStream = workflowInstanceStream(workflowId);
    const primaryStream = primaryOrchestrationGroupStream(workItemId('work-1'));
    const childStream = childOrchestrationGroupStream('group-1', 'watch-1');

    expect(workflowStream).toEqual({
      kind: OrchestrationStreamKind.WorkflowInstance,
      id: workflowId,
    });
    expect(primaryStream).toEqual({
      kind: OrchestrationStreamKind.Group,
      id: 'primary:work-1',
    });
    expect(childStream).toEqual({
      kind: OrchestrationStreamKind.Group,
      id: 'group:group-1:watch:watch-1',
    });
  });

  it('keeps child coordination keys injective when components contain delimiters', () => {
    const left = childOrchestrationGroupStream('a:watch:b', 'c');
    const right = childOrchestrationGroupStream('a', 'b:watch:c');

    expect(left.id).not.toBe(right.id);
  });

  it('constructs integration streams from validated adapter identities', () => {
    const github = adapterId('github');
    const stream = integrationStream(github);

    expect(BuiltInAdapterId.GitHub).toBe(github);
    expect(GitHubAdapterId).toBe(github);
    expect(stream).toEqual({ kind: IntegrationStreamKind.Integration, id: github });
    expectTypeOf(stream.id).toEqualTypeOf<AdapterId>();
    expect(() => adapterId('GitHub')).toThrow('Invalid AdapterId');
  });

  it('hides Activity decision composite ids behind its named constructor', () => {
    const activation = activationId('activation-1');
    const stream = activityDecisionStream(activation, 'merge');

    expect(stream).toEqual({
      kind: ActivityStreamKind.Decision,
      id: 'activation-1:pr.merge',
    });
    expectTypeOf(activityDecisionStream).parameter(0).toEqualTypeOf<ActivationId>();
    expectTypeOf(activityDecisionStream).parameter(1).toEqualTypeOf<PrAction>();
  });

  it('keeps Activity decision ids injective when components contain delimiters', () => {
    const left = activityDecisionStream(activationId('a:pr.merge'), 'approve');
    const right = activityDecisionStream(activationId('a'), 'merge:pr.approve' as PrAction);

    expect(left.id).not.toBe(right.id);
  });
});
