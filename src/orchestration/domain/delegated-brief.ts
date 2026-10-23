import type { DelegationReservation } from '../contracts/delegation.js';

type Child = Pick<
  DelegationReservation['children'][number],
  'objective' | 'criteria' | 'outputs' | 'context'
>;

/**
 * The text a delegated child is opened with. The objective stays a one-line summary and
 * the work item's title; this is where the child reads what it was asked to do.
 */
export function renderDelegatedBrief(child: Child): string {
  return [
    `Assignment from your delegating parent: ${child.objective}`,
    '',
    'Acceptance criteria:',
    ...child.criteria.map((criterion) => `- ${criterion}`),
    ...outputLines(child.outputs),
    ...contextLines(child.context),
  ].join('\n');
}

function outputLines(outputs: Child['outputs']): string[] {
  if (outputs.length === 0) return [];
  return [
    '',
    'Outputs to deliver:',
    ...outputs.map((output) => {
      const kind = 'kind' in output ? output.kind : 'artifact';
      return `- ${output.name} (${kind}${output.required === false ? ', optional' : ''})`;
    }),
  ];
}

function contextLines(references: Child['context']): string[] {
  if (references.length === 0) return [];
  return [
    '',
    'Artifacts granted to you (read each with wake_artifacts_read, passing its workItemId and revisionId; they are also in your artifact manifest):',
    ...references.map((reference) => `- ${reference.workItemId} ${reference.revisionId}`),
  ];
}
