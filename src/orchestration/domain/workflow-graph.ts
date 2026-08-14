import type { CompiledStage } from '../contracts/config.js';
import type { StageName } from '../contracts/identifiers.js';
import { stageName } from '../contracts/identifiers.js';
import { TransitionTargetKind } from '../contracts/vocabulary.js';

function edges(stages: Readonly<Record<StageName, CompiledStage>>, name: StageName): StageName[] {
  return Object.values(stages[name]!.on).flatMap((route) =>
    [
      route.target,
      ...(route.watchGates ?? []).map((gate) => gate.onRejectTarget),
      ...(route.eventTransitions ?? []).map((transition) => transition.target),
    ].flatMap((target) =>
      target.kind === TransitionTargetKind.Stage ? [target.stage] : [],
    ),
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
