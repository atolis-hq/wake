import type { CompiledWorkflow } from '../contracts/config.js';
import type {
  DelegatedAssignment,
  DelegationReservation,
  DelegationResult,
} from '../contracts/delegation.js';
import { DelegationOutputKind } from '../contracts/vocabulary.js';

/** An assignment may add obligations, but cannot remove the workflow's declared obligations. */
export function assertConfiguredOutputs(
  configured: CompiledWorkflow['outputs'],
  outputs: DelegatedAssignment['outputs'],
): void {
  for (const [name, requirement] of Object.entries(configured ?? {})) {
    const output = outputs.find((entry) => entry.name === name);
    if (output === undefined) {
      if (requirement.required !== false)
        throw new Error('Missing configured required output: ' + name);
      continue;
    }
    if (
      ('kind' in output ? output.kind : DelegationOutputKind.Artifact) !== requirement.kind ||
      (requirement.required !== false && output.required === false)
    )
      throw new Error('Assignment weakens configured output: ' + name);
  }
}

export function hasRequiredOutputs(
  child: DelegationReservation['children'][number],
  outputs: DelegationResult['outputs'],
): boolean {
  return (
    new Set(outputs.map((output) => output.name)).size === outputs.length &&
    outputs.every(
      (output) =>
        output.reference.workItemId === child.workItemId &&
        child.outputs.some((declared) => declared.name === output.name),
    ) &&
    child.outputs
      .filter((output) => output.required !== false)
      .every((required) => outputs.some((output) => output.name === required.name))
  );
}
