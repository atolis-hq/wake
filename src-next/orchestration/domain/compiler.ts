import type { ActivityRegistry } from '../../activities/index.js';
import {
  workflowDefinitionConfigSchema,
  type CompiledOutcomeRoute,
  type CompiledStage,
  type CompiledSupplementalCommand,
  type CompiledWorkflow,
  type StageConfig,
  type WorkflowDefinitionConfig,
} from '../contracts/config.js';

export function compileWorkflow(
  name: string,
  input: unknown,
  activities: ActivityRegistry,
  knownWorkflowNames: readonly string[] = [name],
): CompiledWorkflow {
  if (name.trim().length === 0) throw new Error('Workflow name must not be empty');
  const config = workflowDefinitionConfigSchema.parse(input) as WorkflowDefinitionConfig;
  const stageNames = Object.keys(config.stages);
  const entry = config.entry ?? stageNames[0]!;
  if (!(entry in config.stages)) throw new Error(`Unknown workflow entry stage: ${entry}`);
  const stages = compileStages(name, config.stages, activities);
  const commands = compileCommands(config, activities);
  const watches = compileWatches(config, stageNames, knownWorkflowNames);
  assertReachable(entry, stages);
  assertCyclesBounded(stages);
  return Object.freeze({
    name,
    entry,
    commands: Object.freeze(commands),
    watches: Object.freeze(watches),
    stages: Object.freeze(stages),
  });
}

function compileWatches(
  config: WorkflowDefinitionConfig,
  stageNames: readonly string[],
  knownWorkflowNames: readonly string[],
) {
  const ids = new Set<string>();
  return (config.watches ?? []).map((watch) => {
    if (ids.has(watch.id)) throw new Error(`Duplicate watch id: ${watch.id}`);
    ids.add(watch.id);
    const unknownStages = watch.while.stages.filter((stage) => !stageNames.includes(stage));
    if (unknownStages.length > 0)
      throw new Error(`Unknown watch stage: ${unknownStages.join(', ')}`);
    if (!knownWorkflowNames.includes(watch.workflow))
      throw new Error(`Unknown watch workflow: ${watch.workflow}`);
    return Object.freeze({
      ...watch,
      while: Object.freeze({
        stages: Object.freeze([...watch.while.stages]),
        statuses: Object.freeze([...watch.while.statuses]),
      }),
      ...(watch.on === undefined
        ? {}
        : { on: Object.freeze({ events: Object.freeze([...watch.on.events]) }) }),
      ...(watch.schedule === undefined ? {} : { schedule: Object.freeze({ ...watch.schedule }) }),
    });
  });
}

function compileStages(
  workflowName: string,
  configured: WorkflowDefinitionConfig['stages'],
  activities: ActivityRegistry,
): Record<string, CompiledStage> {
  return Object.fromEntries(
    Object.entries(configured).map(([stageName, stage]) => [
      stageName,
      compileStage(workflowName, stageName, stage, configured, activities),
    ]),
  );
}

function compileStage(
  workflowName: string,
  stageName: string,
  stage: StageConfig,
  allStages: WorkflowDefinitionConfig['stages'],
  activities: ActivityRegistry,
): CompiledStage {
  const on = Object.fromEntries(
    Object.entries(stage.on).map(([outcomeKind, route]) => {
      if (!isTerminal(route.then) && !(route.then in allStages))
        throw new Error(`Unknown transition target: ${route.then}`);
      const followOns = route.activities?.map((activity) => ({
        ...activity,
        with: activities.validateInput(activity.use, activity.with),
      }));
      const compiled: CompiledOutcomeRoute = Object.freeze({
        then: route.then,
        ...(route.repeat === undefined ? {} : { repeat: route.repeat }),
        ...(route.retry === undefined ? {} : { retry: route.retry }),
        ...(followOns === undefined ? {} : { activities: Object.freeze(followOns) }),
        id: `${workflowName}:${stageName}:${outcomeKind}`,
      });
      return [outcomeKind, compiled];
    }),
  );
  return Object.freeze({
    ...stage,
    with: activities.validateInput(stage.activity, stage.with),
    on: Object.freeze(on),
  });
}

function compileCommands(
  config: WorkflowDefinitionConfig,
  activities: ActivityRegistry,
): Record<string, CompiledSupplementalCommand> {
  return Object.fromEntries(
    Object.entries(config.commands ?? {}).map(([command, configured]) => [
      command,
      Object.freeze({
        activity: configured.activity,
        with: activities.validateInput(configured.activity, configured.with),
        allowedActors: Object.freeze([...configured.allowedActors]),
      }),
    ]),
  );
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
