import type {
  CompiledResourceTransition,
  CompiledOutcomeRoute,
  ResourceTransitionConfig,
  WorkflowDefinitionConfig,
} from '../contracts/config.js';

export function compileResourceTransitions(
  entries: readonly ResourceTransitionConfig[],
  inheritedThen: string,
  outcomeKind: string,
  allStages: WorkflowDefinitionConfig['stages'],
  isReservedTerminal: (target: string) => boolean,
  compileTarget: (target: string, outcome: string) => CompiledOutcomeRoute['target'],
): readonly CompiledResourceTransition[] {
  return Object.freeze(
    entries.map((entry) => {
      const then = entry.then ?? inheritedThen;
      if (!isReservedTerminal(then) && !(then in allStages))
        throw new Error(`Unknown resourceTransitions target: ${then}`);
      return Object.freeze({
        event: entry.events[0],
        ...(!('where' in entry) || entry.where === undefined ? {} : { where: entry.where }),
        target: compileTarget(then, outcomeKind),
      });
    }),
  );
}
