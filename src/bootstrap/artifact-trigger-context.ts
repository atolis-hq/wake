import { EventActorKind, correlationId, type EventJournal } from '@atolis-hq/eventing';
import { ActivityOutcomeKind } from '../activities/index.js';
import { ArtifactContextProvenanceKind, type ArtifactContextService } from '../artifacts/index.js';
import {
  ControlEventType,
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
  readonly orchestration: OrchestrationService;
  readonly triggers: readonly TriggerConfig[];
  readonly now: () => string;
}) {
  async function enroll(item: string) {
    let claimed: { triggerId: string; coordinationKey: string; workflowInstanceId: string } | null =
      null;
    for (const envelope of await input.journal.readStream(triggerInvocationStream(item))) {
      const event = selectControlEvent(envelope);
      if (event?.event.eventType === ControlEventType.TriggerInvocationClaimed) {
        claimed = event.event.payload;
        break;
      }
    }
    if (claimed === null) return null;
    const config = input.triggers.find((trigger) => trigger.id === claimed.triggerId);
    if (
      config?.contextScope === undefined ||
      claimed.coordinationKey !== `context:${config.contextScope}`
    )
      return null;
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
    return config.contextScope;
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
      const scope = await enroll(item);
      if (scope === null) return {};
      const view = await input.contexts.get(scope);
      return {
        sharedReferences: await input.contexts.references(scope, workItemId(item)),
        currentMemory: view.memory,
      };
    },
    async reconcile() {
      const workflows = await input.orchestration.listAll();
      for (const workflow of workflows) {
        if (
          workflow.status !== WorkflowStatus.Completed &&
          workflow.status !== WorkflowStatus.Superseded
        )
          continue;
        const scope = await enroll(workflow.workItemId);
        if (scope === null) continue;
        const view = await input.contexts.get(scope);
        const member = view.members.find(
          (candidate) => candidate.workItemId === workflow.workItemId,
        )!;
        await input.contexts.publish(
          {
            contextScope: scope,
            workItemId: workflow.workItemId,
            publicationId: workflow.workflowInstanceId,
            successful:
              workflow.status === WorkflowStatus.Completed &&
              workflow.lastOutcome?.kind !== ActivityOutcomeKind.Failed,
            exports: [],
            expectedMemory: member.expectedMemory,
          },
          async (activationId, item) =>
            workflows.some(
              (candidate) =>
                candidate.workItemId === item &&
                candidate.acceptedOutcomes.some((id) => id === activationId),
            ),
          context(workflow.workItemId),
        );
      }
    },
  };
}
