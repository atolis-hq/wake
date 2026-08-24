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
  compileTarget: (target: string, outcome: string) => CompiledOutcomeRoute['target'],
): readonly CompiledResourceTransition[] {
  return Object.freeze(
    entries.map((entry) => {
      const then = entry.then ?? context.inheritedThen;
      if (context.requiresExplicitTarget && entry.then === undefined)
        throw new Error('resourceTransitions under then: wait require then');
      if (then === 'wait') throw new Error('resourceTransitions cannot target wait');
      if (!isReservedTarget(then) && !(then in allStages))
        throw new Error(`Unknown resourceTransitions target: ${then}`);
      return Object.freeze({
        event: entry.events[0],
        ...(!('where' in entry) || entry.where === undefined ? {} : { where: entry.where }),
        target: compileTarget(then, context.outcomeKind),
      });
    }),
  );
}

interface ResourceTransitionCompilerContext {
  readonly inheritedThen: string;
  readonly outcomeKind: string;
  readonly requiresExplicitTarget: boolean;
}
