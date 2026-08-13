import { matchesRequiredValues, type MatchMode } from '../../kernel/index.js';
import type { WorkflowSelectorConfig } from '../contracts/config.js';
import { workflowName, type WorkflowName } from '../contracts/identifiers.js';

// Facts an adapter may supply about a newly created WorkItem. It carries no workflow
// name: configuration is the only routing authority.
export interface WorkflowCandidate {
  readonly tags: readonly string[];
  readonly kind?: string | undefined;
  readonly adapter?: string | undefined;
}

export interface CompiledWorkflowSelector {
  readonly match: WorkflowSelectorConfig['match'];
  readonly matchMode: MatchMode;
  readonly workflow: WorkflowName;
}

export function compileWorkflowSelectors(
  selectors: readonly WorkflowSelectorConfig[],
): readonly CompiledWorkflowSelector[] {
  return selectors.map((selector) => ({
    match: selector.match,
    matchMode: selector.matchMode,
    workflow: workflowName(selector.workflow),
  }));
}

export function selectWorkflow(
  candidate: WorkflowCandidate,
  selectors: readonly CompiledWorkflowSelector[],
  fallback: WorkflowName,
): WorkflowName {
  return selectors.find((selector) => selectorMatches(selector, candidate))?.workflow ?? fallback;
}

function selectorMatches(
  selector: CompiledWorkflowSelector,
  candidate: WorkflowCandidate,
): boolean {
  const { match, matchMode } = selector;
  return (
    matchesRequiredValues(matchMode, match.tags ?? [], candidate.tags) &&
    matchesRequiredValues(matchMode, match.kind ?? [], singleton(candidate.kind)) &&
    matchesRequiredValues(matchMode, match.adapter ?? [], singleton(candidate.adapter))
  );
}

function singleton(value: string | undefined): readonly string[] {
  return value === undefined ? [] : [value];
}
