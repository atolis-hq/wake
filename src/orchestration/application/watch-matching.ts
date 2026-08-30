import {
  ActivityEventType,
  PullRequestCheckState,
  selectActivityEvent,
} from '../../activities/index.js';
import type { CommandContext } from '../../kernel/index.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import type { StartWorkflow } from './start-workflow.js';

type PersistedEvent = Parameters<typeof selectActivityEvent>[0];

// Loads a definition per instance (operation-scoped when a command context is
// given, read-only otherwise) and returns every watch whose event, stage,
// status, and predicate all agree with the incoming event.
export async function matchWatches(
  loaded: readonly { readonly view: WorkflowInstanceView; readonly sequence: number }[],
  event: PersistedEvent,
  workflows: StartWorkflow,
  context: CommandContext | undefined,
) {
  const matches = await Promise.all(
    loaded.map(async ({ view: parent, sequence }) => {
      if (!(await workflows.isWorkItemOpen(parent.workItemId))) return [];
      const definition =
        context === undefined
          ? await workflows.definitionFor(parent)
          : await workflows.definitionForOperation(parent, sequence, context);
      if (definition === null) return [];
      return definition.watches
        .filter(
          (watch) =>
            watch.on?.events.includes(event.event.eventType) === true &&
            watch.while.stages.includes(parent.currentStage) &&
            watch.while.statuses.some((status) => status === parent.status) &&
            matchesWatchPredicate(watch.where, event),
        )
        .map((watch) => ({ parent, watch }));
    }),
  );
  return matches.flat();
}

function matchesWatchPredicate(
  predicate: { readonly checks: typeof PullRequestCheckState.Failing } | undefined,
  event: PersistedEvent,
): boolean {
  if (predicate === undefined) return true;
  const activityEvent = selectActivityEvent(event);
  return (
    activityEvent?.event.eventType === ActivityEventType.PrChecksChanged &&
    activityEvent.event.payload.checks === PullRequestCheckState.Failing
  );
}
