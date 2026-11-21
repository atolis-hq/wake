import { ActivityOutcomeKind } from '../../activities/index.js';
import type {
  CompiledOutcomeRoute,
  CompiledResourceTransition,
  ResourceTransitionConfig,
  WorkflowDefinitionConfig,
} from '../contracts/config.js';

export function compileResourceTransitions(
  entries: readonly ResourceTransitionConfig[],
  context: ResourceTransitionCompilerContext,
  allStages: WorkflowDefinitionConfig['stages'],
  isReservedTarget: (target: string) => boolean,
  compileTarget: (
    target: string,
    outcome: string,
    concludesWork?: boolean,
  ) => CompiledOutcomeRoute['target'],
): readonly CompiledResourceTransition[] {
  return Object.freeze(
    entries.map((entry) => {
      const then = entry.then ?? context.inheritedThen;
      if (context.requiresExplicitTarget && entry.then === undefined)
        throw new Error('resourceTransitions under then: wait require then');
      if (then === 'wait') throw new Error('resourceTransitions cannot target wait');
      if (!isReservedTarget(then) && !(then in allStages))
        throw new Error(`Unknown resourceTransitions target: ${then}`);
      const concludesWork = entryConcludesWork(entry, then, context.concludesWork);
      return Object.freeze({
        event: entry.events[0],
        ...(!('retry' in entry) || entry.retry === undefined ? {} : { retry: entry.retry }),
        ...(!('where' in entry) || entry.where === undefined ? {} : { where: entry.where }),
        target: compileTarget(then, context.outcomeKind, concludesWork),
      });
    }),
  );
}

// An entry concludes when it declares so, or inherits then: done from a concluding route.
function entryConcludesWork(
  entry: ResourceTransitionConfig,
  then: string,
  routeConcludesWork: boolean,
): boolean {
  const declared = 'concludesWork' in entry && entry.concludesWork === true;
  if (declared && then !== ActivityOutcomeKind.Done)
    throw new Error('resourceTransitions concludesWork is only valid with then: done');
  return declared || (entry.then === undefined && routeConcludesWork);
}

interface ResourceTransitionCompilerContext {
  readonly inheritedThen: string;
  readonly outcomeKind: string;
  readonly requiresExplicitTarget: boolean;
  readonly concludesWork: boolean;
}
