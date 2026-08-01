import { z } from 'zod';
import {
  ActivityExecutionKind,
  ActivityOutcomeKind,
  activityName,
  type ActivityDefinition,
} from '../../../src-next/activities/index.js';
import type { WorkflowRouter } from '../../../src-next/integrations/index.js';
import { workflowName } from '../../../src-next/orchestration/index.js';
import type { TestWorld } from './world.js';

const INTAKE_WORKFLOW = 'default';

// Admission always routes a newly observed object into a workflow, so an intake test
// needs one to route to. This is the minimum a world can offer.
export function configureIntakeRouting(world: TestWorld): WorkflowRouter {
  const noop: ActivityDefinition = {
    name: activityName('intake.noop'),
    inputSchema: z.object({}).strict(),
    outcomeSchema: z.object({ kind: z.literal(ActivityOutcomeKind.Done) }).strict(),
    outcomeKinds: [ActivityOutcomeKind.Done],
    resources: [],
    executionKind: ActivityExecutionKind.Deterministic,
    handler: { execute: async () => ({ kind: ActivityOutcomeKind.Done }) },
  };
  world.registerActivity(noop);
  world.configureWorkflow(INTAKE_WORKFLOW, {
    stages: { start: { activity: 'intake.noop', with: {}, on: { done: { then: 'done' } } } },
  });
  return { select: () => workflowName(INTAKE_WORKFLOW) };
}
