import type { AgentContextAssignment, AgentContextReader } from '../activities/index.js';

/**
 * A delegated child has no provider ticket, so its objective and acceptance criteria come
 * from the parent's assignment. Provider-sourced context stays authoritative when present.
 */
export function withDelegatedAssignment(
  reader: AgentContextReader,
  assignmentFor: (workItemId: string) => Promise<AgentContextAssignment | undefined>,
): AgentContextReader {
  return {
    async forWorkItem(workItemId, options) {
      const context = await reader.forWorkItem(workItemId, options);
      const assignment = await assignmentFor(workItemId);
      if (assignment === undefined) return context;
      const hasTicket = context.title !== '' || context.body !== '';
      return {
        ...context,
        title: hasTicket ? context.title : assignment.objective,
        body: hasTicket ? context.body : criteriaText(assignment.criteria),
        assignment,
      };
    },
  };
}

function criteriaText(criteria: readonly string[]): string {
  return ['Acceptance criteria:', ...criteria.map((criterion) => `- ${criterion}`)].join('\n');
}
