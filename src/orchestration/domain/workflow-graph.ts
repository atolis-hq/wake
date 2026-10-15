import type { CompiledStage, TransitionTarget } from '../contracts/config.js';
import type { StageName } from '../contracts/identifiers.js';
import { stageName } from '../contracts/identifiers.js';
import { TransitionTargetKind } from '../contracts/vocabulary.js';

function edges(stages: Readonly<Record<StageName, CompiledStage>>, name: StageName): StageName[] {
  return Object.values(stages[name]!.on).flatMap((route) =>
    [
      route.target,
      ...(route.watchGates ?? []).map((gate) => gate.onRejectTarget),
      ...(route.resourceTransitions ?? []).map((transition) => transition.target),
    ].flatMap((target) => (target.kind === TransitionTargetKind.Stage ? [target.stage] : [])),
  );
}

export function assertReachable(
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

export function assertCyclesBounded(stages: Readonly<Record<StageName, CompiledStage>>): void {
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

/** Cost of a stage that cannot reach a terminal stage; finite so it survives JSON. */
export const UnreachableRemainingSteps = Number.MAX_SAFE_INTEGER;

function routeTargets(stage: CompiledStage): TransitionTarget[] {
  return Object.values(stage.on).flatMap((route) => [
    route.target,
    ...(route.await === undefined ? [] : [route.await.resume]),
    ...(route.watchGates ?? []).map((gate) => gate.onRejectTarget),
    ...(route.resourceTransitions ?? []).map((transition) => transition.target),
  ]);
}

/**
 * Minimum number of agent-running stages from each stage to a terminal stage,
 * counting the stage itself. Costs are non-negative, so loop-backs never lie on
 * a shortest path. Stages with no path to completion get UnreachableRemainingSteps.
 */
export function remainingAgentSteps(
  stages: Readonly<Record<StageName, CompiledStage>>,
  isAgentActivity: (activity: CompiledStage['activity']) => boolean,
): Readonly<Record<StageName, number>> {
  const names = Object.keys(stages) as StageName[];
  const cost: Record<string, number> = Object.fromEntries(
    names.map((name) => [name, UnreachableRemainingSteps]),
  );
  const targetCost = (target: TransitionTarget): number => {
    if (target.kind === TransitionTargetKind.Complete) return 0;
    if (target.kind === TransitionTargetKind.Stage) return cost[target.stage]!;
    return UnreachableRemainingSteps;
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const name of names) {
      const stage = stages[name]!;
      const onward = Math.min(UnreachableRemainingSteps, ...routeTargets(stage).map(targetCost));
      const next =
        onward >= UnreachableRemainingSteps
          ? UnreachableRemainingSteps
          : onward + (isAgentActivity(stage.activity) ? 1 : 0);
      if (next < cost[name]!) {
        cost[name] = next;
        changed = true;
      }
    }
  }
  return cost as Record<StageName, number>;
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
