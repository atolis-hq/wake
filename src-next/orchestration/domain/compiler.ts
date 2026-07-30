import type { ActivityRegistry } from '../../activities/index.js';
import {
  workflowDefinitionConfigSchema,
  type CompiledOutcomeRoute,
  type CompiledStage,
  type CompiledWorkflow,
  type WorkflowDefinitionConfig,
} from '../contracts/config.js';

export function compileWorkflow(
  name: string,
  input: unknown,
  activities: ActivityRegistry,
): CompiledWorkflow {
  if (name.trim().length === 0) throw new Error('Workflow name must not be empty');
  const config = workflowDefinitionConfigSchema.parse(input) as WorkflowDefinitionConfig;
  const stageNames = Object.keys(config.stages);
  const entry = config.entry ?? stageNames[0]!;
  if (!(entry in config.stages)) throw new Error(`Unknown workflow entry stage: ${entry}`);

  const stages: Record<string, CompiledStage> = {};
  for (const [stageName, stage] of Object.entries(config.stages)) {
    activities.validateInput(stage.activity, stage.with);
    const on: Record<string, CompiledOutcomeRoute> = {};
    for (const [outcomeKind, route] of Object.entries(stage.on)) {
      if (!isTerminal(route.then) && !(route.then in config.stages))
        throw new Error(`Unknown transition target: ${route.then}`);
      const followOns = route.activities?.map((activity) => ({
        ...activity,
        with: activities.validateInput(activity.use, activity.with),
      }));
      on[outcomeKind] = Object.freeze({
        then: route.then,
        ...(route.repeat === undefined ? {} : { repeat: route.repeat }),
        ...(route.retry === undefined ? {} : { retry: route.retry }),
        ...(followOns === undefined ? {} : { activities: Object.freeze(followOns) }),
        id: `${name}:${stageName}:${outcomeKind}`,
      });
    }
    stages[stageName] = Object.freeze({
      ...stage,
      with: activities.validateInput(stage.activity, stage.with),
      on: Object.freeze(on),
    });
  }
  assertReachable(entry, stages);
  assertCyclesBounded(stages);
  return Object.freeze({ name, entry, stages: Object.freeze(stages) });
}

const isTerminal = (target: string): boolean => target === 'done' || target === 'await-human';

function edges(stages: Readonly<Record<string, CompiledStage>>, name: string): string[] {
  return Object.values(stages[name]!.on).flatMap((route) =>
    isTerminal(route.then) ? [] : [route.then],
  );
}

function assertReachable(entry: string, stages: Readonly<Record<string, CompiledStage>>): void {
  const reached = new Set<string>();
  const visit = (name: string): void => {
    if (reached.has(name)) return;
    reached.add(name);
    for (const target of edges(stages, name)) visit(target);
  };
  visit(entry);
  const missing = Object.keys(stages).filter((name) => !reached.has(name));
  if (missing.length > 0) throw new Error(`Unreachable workflow stage: ${missing.join(', ')}`);
}

function assertCyclesBounded(stages: Readonly<Record<string, CompiledStage>>): void {
  for (const [from, stage] of Object.entries(stages)) {
    for (const route of Object.values(stage.on)) {
      if (
        !isTerminal(route.then) &&
        canReach(stages, route.then, from) &&
        route.repeat === undefined
      )
        throw new Error(`Cycle-closing route ${route.id} requires repeat.max`);
    }
  }
}

function canReach(
  stages: Readonly<Record<string, CompiledStage>>,
  from: string,
  target: string,
): boolean {
  const seen = new Set<string>();
  const visit = (name: string): boolean => {
    if (name === target) return true;
    if (seen.has(name)) return false;
    seen.add(name);
    return edges(stages, name).some(visit);
  };
  return visit(from);
}
