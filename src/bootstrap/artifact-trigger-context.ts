import { EventActorKind, correlationId, type EventJournal } from '@atolis-hq/eventing';
import { ActivityOutcomeKind } from '../activities/index.js';
import {
  ArtifactContextProvenanceKind,
  type ArtifactContextService,
  type ArtifactService,
} from '../artifacts/index.js';
import {
  ControlEventType,
  artifactContextCoordinationKey,
  selectControlEvent,
  triggerInvocationStream,
  type TriggerConfig,
} from '../control-plane/index.js';
import { WorkflowStatus, type OrchestrationService } from '../orchestration/index.js';
import { workItemId } from '../work/index.js';

/** Only durable claims matching the operator binding authorize named enrollment. */
export function createArtifactTriggerContext(input: {
  readonly journal: EventJournal;
  readonly contexts: ArtifactContextService;
  readonly artifacts: ArtifactService;
  readonly orchestration: OrchestrationService;
  readonly triggers: readonly TriggerConfig[];
  readonly now: () => string;
}) {
  // Completed receipts and immutable claim bindings need no repeated stream reads in a resident host.
  const reconciled = new Set<string>();
  const bindings = new Map<string, { contextScope: string; workflowInstanceId: string } | null>();

  async function binding(item: string) {
    if (bindings.has(item)) return bindings.get(item) ?? null;
    for (const envelope of await input.journal.readStream(triggerInvocationStream(item))) {
      const event = selectControlEvent(envelope);
      if (event?.event.eventType !== ControlEventType.TriggerInvocationClaimed) continue;
      const claimed = event.event.payload;
      const config = input.triggers.find((trigger) => trigger.id === claimed.triggerId);
      if (
        config?.contextScope === undefined ||
        claimed.coordinationKey !== artifactContextCoordinationKey(config.contextScope)
      )
        break;
      const result = {
        contextScope: config.contextScope,
        workflowInstanceId: claimed.workflowInstanceId,
      };
      await input.contexts.enroll(
        config.contextScope,
        workItemId(item),
        {
          kind: ArtifactContextProvenanceKind.Trigger,
          triggerId: config.id,
          invocationId: claimed.workflowInstanceId,
        },
        context(item),
      );
      bindings.set(item, result);
      return result;
    }
    bindings.set(item, null);
    return null;
  }

  function context(item: string) {
    return {
      commandId: `artifact-trigger:${item}`,
      correlationId: correlationId(item),
      occurredAt: input.now(),
      actor: { kind: EventActorKind.System, id: 'artifact-trigger-context' },
    };
  }

  return {
    async provision(item: string) {
      const bound = await binding(item);
      if (bound === null) return {};
      const view = await input.contexts.get(bound.contextScope);
      return {
        contextScope: bound.contextScope,
        sharedReferences: await input.contexts.references(bound.contextScope, workItemId(item)),
        currentMemory: view.memory,
      };
    },
    async reconcile() {
      for (const workflow of await input.orchestration.listAll()) {
        if (
          reconciled.has(workflow.workflowInstanceId) ||
          (workflow.status !== WorkflowStatus.Completed &&
            workflow.status !== WorkflowStatus.Superseded)
        )
          continue;
        try {
          const bound = await binding(workflow.workItemId);
          // A trigger claim authorizes its invocation, not every workflow on its WorkItem.
          if (bound !== null && bound.workflowInstanceId === workflow.workflowInstanceId) {
            const view = await input.contexts.get(bound.contextScope);
            const member = view.members.find(
              (candidate) => candidate.workItemId === workflow.workItemId,
            )!;
            const accepted = async (id: string, item?: string) =>
              item === workflow.workItemId &&
              workflow.acceptedOutcomes.some((acceptedId) => acceptedId === id);
            const revisions = await input.artifacts.latestPublished(workflow.workItemId, (id) =>
              accepted(id, workflow.workItemId),
            );
            const successful =
              workflow.status === WorkflowStatus.Completed &&
              workflow.lastOutcome?.kind !== ActivityOutcomeKind.Failed;
            await input.contexts.publish(
              {
                contextScope: bound.contextScope,
                workItemId: workflow.workItemId,
                publicationId: workflow.workflowInstanceId,
                successful,
                exports: revisions
                  .filter((revision) => successful && revision.contextExport === bound.contextScope)
                  .map((revision) => ({
                    workItemId: workflow.workItemId,
                    revisionId: revision.revisionId,
                  })),
                expectedMemory: member.expectedMemory,
              },
              accepted,
              context(workflow.workItemId),
            );
          }
          reconciled.add(workflow.workflowInstanceId);
        } catch (error) {
          // Retry this invocation next pass without starving other scopes or trigger admission.
          console.error(
            `Artifact context publication failed for ${workflow.workflowInstanceId}`,
            error,
          );
        }
      }
    },
  };
}
