import type { AgentContextReader } from '../activities/index.js';
import type { WorkService } from '../work/index.js';

/**
 * Work with no provider ticket, such as a delegated child, has no title to read. Its
 * objective is its title, so fall back to that; ticket text stays authoritative when present.
 */
export function withObjectiveTitle(
  reader: AgentContextReader,
  work: Pick<WorkService, 'get'>,
): AgentContextReader {
  return {
    async forWorkItem(workItemId, options) {
      const context = await reader.forWorkItem(workItemId, options);
      if (context.title !== '') return context;
      const objective = (await work.get(workItemId as never))?.objective;
      return objective === undefined ? context : { ...context, title: objective };
    },
  };
}
