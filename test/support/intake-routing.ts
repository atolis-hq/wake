import { z } from 'zod';
import {
  ActivityExecutionKind,
  ActivityOutcomeKind,
  ActivityRegistry,
  activityName,
  type ActivityDefinition,
} from '../../src/activities/index.js';
import type { WorkflowRouter } from '../../src/integrations/index.js';
import type { EventJournal, ProjectionStore } from '../../src/kernel/index.js';
import {
  compileWorkflow,
  createOrchestrationService,
  workflowName,
  type CompiledWorkflow,
} from '../../src/orchestration/index.js';
import type { WorkService } from '../../src/work/index.js';

const INTAKE_WORKFLOW = 'default';

// Raw-service tests (no TestWorld) need the same minimum admission requires: a workflow
// to route a newly observed object into. Mirrors test/e2e/support/intake-routing.ts
// for callers that build their own journal/work services instead of a TestWorld.
export function createTestIntakeRouting(
  journal: EventJournal,
  work: WorkService,
  projections?: ProjectionStore,
): { orchestration: ReturnType<typeof createOrchestrationService>; routing: WorkflowRouter } {
  const noop: ActivityDefinition = {
    name: activityName('intake.noop'),
    inputSchema: z.object({}).strict(),
    outcomeSchema: z.object({ kind: z.literal(ActivityOutcomeKind.Done) }).strict(),
    outcomeKinds: [ActivityOutcomeKind.Done],
    resources: [],
    executionKind: ActivityExecutionKind.Deterministic,
    handler: { execute: async () => ({ kind: ActivityOutcomeKind.Done }) },
  };
  const activities = new ActivityRegistry();
  activities.register(noop);
  const definitions: Record<string, CompiledWorkflow> = {};
  definitions[INTAKE_WORKFLOW] = compileWorkflow(
    INTAKE_WORKFLOW,
    { stages: { start: { activity: 'intake.noop', with: {}, on: { done: { then: 'done' } } } } },
    activities,
    [INTAKE_WORKFLOW],
  );
  return {
    orchestration: createOrchestrationService(journal, work, definitions, projections),
    routing: { select: () => workflowName(INTAKE_WORKFLOW) },
  };
}
