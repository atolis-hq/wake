import {
  activityName,
  ActivityOutcomeKind,
  type ActivityRegistry,
} from '../../activities/index.js';
import {
  workflowDefinitionConfigSchema,
  type ApprovalAuthority,
  type AwaitConfig,
  type CompiledAwait,
  type CompiledOutcomeRoute,
  type CompiledStage,
  type CompiledSupplementalCommand,
  type CompiledWorkflow,
  type StageConfig,
  type WorkflowDefinitionConfig,
} from '../contracts/config.js';
import {
  commandName,
  signalName,
  stageName,
  watchId,
  workflowName,
  type StageName,
} from '../contracts/identifiers.js';
import { ApprovalAuthorityKind, TransitionTargetKind } from '../contracts/vocabulary.js';

export function compileWorkflow(
  name: string,
  input: unknown,
  activities: ActivityRegistry,
  knownWorkflowNames: readonly string[] = [name],
): CompiledWorkflow {
  const compiledName = workflowName(name);
  const config = workflowDefinitionConfigSchema.parse(input) as WorkflowDefinitionConfig;
  const rawStageNames = Object.keys(config.stages);
  for (const candidate of rawStageNames) {
    if (isReservedTerminal(candidate)) throw new Error(`Reserved stage name: ${candidate}`);
  }
  const stageNames = rawStageNames.map(stageName);
  const entry = config.entry ?? stageNames[0]!;
  if (!(entry in config.stages)) throw new Error(`Unknown workflow entry stage: ${entry}`);
  const compiledEntry = stageName(entry);
  const declaredWatchIds = new Set((config.watches ?? []).map((watch) => watch.id));
  const stages = compileStages(compiledName, config.stages, activities, declaredWatchIds);
  const commands = compileCommands(config, activities);
  const watches = compileWatches(config, rawStageNames, knownWorkflowNames);
  assertReachable(compiledEntry, stages);
  assertCyclesBounded(stages);
  return Object.freeze({
    name: compiledName,
    entry: compiledEntry,
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
      id: watchId(watch.id),
      workflow: workflowName(watch.workflow),
      while: Object.freeze({
        stages: Object.freeze(watch.while.stages.map(stageName)),
        statuses: Object.freeze([...watch.while.statuses]),
      }),
      ...(watch.on === undefined
        ? {}
        : { on: Object.freeze({ events: Object.freeze([...watch.on.events]) }) }),
      ...(watch.schedule === undefined ? {} : { schedule: Object.freeze({ ...watch.schedule }) }),
    });
  });
}

interface StageCompileContext {
  readonly workflowName: ReturnType<typeof workflowName>;
  readonly activities: ActivityRegistry;
  readonly declaredWatchIds: ReadonlySet<string>;
}

function compileStages(
  compiledWorkflowName: ReturnType<typeof workflowName>,
  configured: WorkflowDefinitionConfig['stages'],
  activities: ActivityRegistry,
  declaredWatchIds: ReadonlySet<string>,
): Record<StageName, CompiledStage> {
  const context: StageCompileContext = {
    workflowName: compiledWorkflowName,
    activities,
    declaredWatchIds,
  };
  return Object.fromEntries(
    Object.entries(configured).map(([stageName, stage]) => [
      stageName,
      compileStage(context, stageName, stage, configured),
    ]),
  ) as Record<StageName, CompiledStage>;
}

function compileStage(
  context: StageCompileContext,
  rawStageName: string,
  stage: StageConfig,
  allStages: WorkflowDefinitionConfig['stages'],
): CompiledStage {
  const { workflowName: compiledWorkflowName, activities, declaredWatchIds } = context;
  const definition = activities.describe(activityName(stage.activity));
  const on = Object.fromEntries(
    Object.entries(stage.on).map(([outcomeKind, route]) => {
      if (!definition.outcomeKinds.includes(outcomeKind))
        throw new Error(
          `Workflow outcome route ${outcomeKind} is not declared by Activity ${definition.name}`,
        );
      if (!isReservedTerminal(route.then) && !(route.then in allStages))
        throw new Error(`Unknown transition target: ${route.then}`);
      const followOns = route.activities?.map((activity) => ({
        use: activityName(activity.use),
        with: activities.validateInput(activityName(activity.use), activity.with),
      }));
      const target = compileTarget(route.then, outcomeKind);
      const compiled: CompiledOutcomeRoute = Object.freeze({
        target,
        ...(route.repeat === undefined ? {} : { repeat: route.repeat }),
        ...(route.retry === undefined ? {} : { retry: route.retry }),
        ...(followOns === undefined ? {} : { activities: Object.freeze(followOns) }),
        ...(route.await === undefined
          ? {}
          : {
              await: compileAwait(
                compiledWorkflowName,
                rawStageName,
                target,
                route.await,
                declaredWatchIds,
              ),
            }),
        id: `${compiledWorkflowName}:${rawStageName}:${outcomeKind}`,
      });
      return [outcomeKind, compiled];
    }),
  );
  return Object.freeze({
    activity: definition.name,
    with: activities.validateInput(definition.name, stage.with),
    ...(stage.execution === undefined ? {} : { execution: stage.execution }),
    on: Object.freeze(on),
  });
}

function compileAwait(
  workflow: ReturnType<typeof workflowName>,
  rawStageName: string,
  resume: CompiledOutcomeRoute['target'],
  config: AwaitConfig,
  declaredWatchIds: ReadonlySet<string>,
): CompiledAwait {
  return Object.freeze({
    signal: signalName(config.signal),
    from: Object.freeze(
      config.from.map((entry) => compileAuthority(workflow, rawStageName, entry, declaredWatchIds)),
    ),
    resume,
  });
}

function compileAuthority(
  workflow: ReturnType<typeof workflowName>,
  rawStageName: string,
  entry: AwaitConfig['from'][number],
  declaredWatchIds: ReadonlySet<string>,
): ApprovalAuthority {
  if (entry === ApprovalAuthorityKind.Human) return { kind: ApprovalAuthorityKind.Human };
  if (entry === ApprovalAuthorityKind.Auto) return { kind: ApprovalAuthorityKind.Auto };
  if (!declaredWatchIds.has(entry.id))
    throw new Error(
      `Unknown watch reference in workflow "${workflow}" stage "${rawStageName}": "${entry.id}"`,
    );
  return { kind: ApprovalAuthorityKind.Watch, watch: watchId(entry.id) };
}

function compileCommands(
  config: WorkflowDefinitionConfig,
  activities: ActivityRegistry,
): Record<ReturnType<typeof commandName>, CompiledSupplementalCommand> {
  return Object.fromEntries(
    Object.entries(config.commands ?? {}).map(([command, configured]) => [
      commandName(command),
      Object.freeze({
        activity: activityName(configured.activity),
        with: activities.validateInput(activityName(configured.activity), configured.with),
        allowedActors: Object.freeze([...configured.allowedActors]),
      }),
    ]),
  ) as Record<ReturnType<typeof commandName>, CompiledSupplementalCommand>;
}

const isReservedTerminal = (target: string): boolean =>
  target === ActivityOutcomeKind.Done || target === 'await-human';

function compileTarget(target: string, outcomeKind: string): CompiledOutcomeRoute['target'] {
  if (target === ActivityOutcomeKind.Done) return { kind: TransitionTargetKind.Complete };
  if (target === 'await-human')
    return { kind: TransitionTargetKind.AwaitSignal, signal: signalName(outcomeKind) };
  return { kind: TransitionTargetKind.Stage, stage: stageName(target) };
}

function edges(stages: Readonly<Record<StageName, CompiledStage>>, name: StageName): StageName[] {
  return Object.values(stages[name]!.on).flatMap((route) =>
    route.target.kind === TransitionTargetKind.Stage ? [route.target.stage] : [],
  );
}

function assertReachable(
  entry: StageName,
  stages: Readonly<Record<StageName, CompiledStage>>,
): void {
  const reached = new Set<StageName>();
  const visit = (name: StageName): void => {
    if (reached.has(name)) return;
    reached.add(name);
    for (const target of edges(stages, name)) visit(target);
  };
  visit(entry);
  const missing = (Object.keys(stages) as StageName[]).filter((name) => !reached.has(name));
  if (missing.length > 0) throw new Error(`Unreachable workflow stage: ${missing.join(', ')}`);
}

function assertCyclesBounded(stages: Readonly<Record<StageName, CompiledStage>>): void {
  for (const [from, stage] of Object.entries(stages)) {
    for (const route of Object.values(stage.on)) {
      if (
        route.target.kind === TransitionTargetKind.Stage &&
        canReach(stages, route.target.stage, stageName(from)) &&
        route.repeat === undefined
      )
        throw new Error(`Cycle-closing route ${route.id} requires repeat.max`);
    }
  }
}

function canReach(
  stages: Readonly<Record<StageName, CompiledStage>>,
  from: StageName,
  target: StageName,
): boolean {
  const seen = new Set<StageName>();
  const visit = (name: StageName): boolean => {
    if (name === target) return true;
    if (seen.has(name)) return false;
    seen.add(name);
    return edges(stages, name).some(visit);
  };
  return visit(from);
}
