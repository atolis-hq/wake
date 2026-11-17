import { WrongExpectedSequenceError, type CommandContext } from '@atolis-hq/eventing';
import { WorkspaceMode } from '../../execution/index.js';
import type { CompiledWorkflow } from '../contracts/config.js';
import type {
  DelegationRecovery,
  DelegationReservation,
  DelegationReviewRefresh,
} from '../contracts/delegation.js';
import {
  OrchestrationEventType as Event,
  WatchGateVerdictSignal,
  type WorkflowOrchestrationEvent,
} from '../contracts/events.js';
import {
  workflowInstanceId,
  type WorkflowInstanceId,
  type WorkflowName,
} from '../contracts/identifiers.js';
import { ApprovalAuthorityKind, WorkflowStatus } from '../contracts/vocabulary.js';
import type { DelegatedWork } from './delegated-work.js';
import { delegationDraft, delegationEventId } from './delegation-ledger.js';
import type { OrchestrationRepository } from './orchestration-repository.js';
import {
  isReviewRefreshAttempt,
  reviewRefreshVerdict,
  ReviewRefreshVerdict,
} from './review-refresh-facts.js';
import type { StartWorkflow } from './start-workflow.js';
import type { WorkflowDefinitionRegistry } from './workflow-definition-registry.js';

export async function requestReviewRefresh(
  dependencies: {
    readonly repository: OrchestrationRepository;
    readonly workflows: StartWorkflow;
    readonly definitions: WorkflowDefinitionRegistry;
    readonly delegated: DelegatedWork;
  },
  child: DelegationReservation['children'][number],
  command: DelegationRecovery,
  context: CommandContext,
) {
  const { repository, workflows, definitions, delegated } = dependencies;
  const loaded = await repository.loadRequired(child.workflowInstanceId);
  if (loaded.view.status !== WorkflowStatus.Completed)
    throw new Error('Review recovery requires a completed child');
  if (child.outputs.filter((entry) => 'kind' in entry).length !== 1)
    throw new Error('Review recovery currently requires exactly one assigned change output');
  const output = child.outputs.find((entry) => entry.name === command.output);
  if (output === undefined || !('kind' in output))
    throw new Error('Name an assigned change output');
  const subject = await delegated.reviewSubject(loaded.view, output);
  if (subject === null || !('revision' in subject.reference))
    throw new Error('Current provider head could not be verified for the child output');
  if (subject.reference.revision !== command.expectedRevision)
    throw new Error('Provider head changed; inspect the current head before requesting review');
  const history = await repository.history(child.workflowInstanceId);
  const subjectKey = `review-refresh:${output.name}:${command.expectedRevision}`;
  const attempts = history.events.flatMap(({ event }) =>
    event.eventType === Event.DelegationReviewRefreshRequested &&
    isReviewRefreshAttempt(event.eventId, child.workflowInstanceId, subjectKey)
      ? [event.payload]
      : [],
  );
  const reusable = await reusableAttempt(repository, attempts.at(-1), output.name, command);
  if (reusable !== undefined) return reusable;
  // A review that ended without a verdict (runner failure, quota, block) leaves this head unreviewed.
  const key = attempts.length === 0 ? subjectKey : `${subjectKey}:attempt:${attempts.length + 1}`;
  const triggerId = delegationEventId(child.workflowInstanceId, key);
  const watch = configuredReviewWatch(history.events, await workflows.definitionFor(loaded.view));
  const review = configuredReviewDefinition(definitions, watch.workflow);
  await definitions.register(watch.workflow, review.fingerprint, review.definition, context);
  const request = {
    requestId: workflowInstanceId(
      `${child.workflowInstanceId}:watch:${watch.id}:trigger:${triggerId}`,
    ),
    watchId: watch.id,
    workflowName: watch.workflow,
    workflowFingerprint: review.fingerprint,
    maxPerGroup: watch.maxPerGroup,
    subject: { name: subject.name, reference: subject.reference },
  };
  return commitRequest(
    repository,
    { id: child.workflowInstanceId, sequence: loaded.sequence, key, triggerId, request },
    context,
  );
}

/** The prior attempt still pending or accepted, if any; a rejection is a verdict and is refused. */
async function reusableAttempt(
  repository: OrchestrationRepository,
  prior: DelegationReviewRefresh | undefined,
  output: string,
  command: DelegationRecovery,
) {
  if (prior === undefined) return undefined;
  const verdict = reviewRefreshVerdict((await repository.load(prior.requestId)).view);
  if (verdict.kind === ReviewRefreshVerdict.Rejected)
    throw new Error(
      `Fresh review ${prior.requestId} rejected ${output} at ${command.expectedRevision}; revise the change before requesting another review`,
    );
  return verdict.kind === ReviewRefreshVerdict.NoVerdict ? undefined : prior;
}

function configuredReviewWatch(
  events: readonly WorkflowOrchestrationEvent[],
  definition: CompiledWorkflow,
) {
  const wait = events
    .filter(
      ({ event }) =>
        event.eventType === Event.SignalWaitStarted &&
        event.payload.signalKind === WatchGateVerdictSignal,
    )
    .at(-1)?.event;
  if (wait?.eventType !== Event.SignalWaitStarted)
    throw new Error('Child has no configured review gate');
  const authorities =
    wait.payload.from?.filter((entry) => entry.kind === ApprovalAuthorityKind.Watch) ?? [];
  if (authorities.length !== 1 || authorities[0]?.kind !== ApprovalAuthorityKind.Watch)
    throw new Error('Child review authority is unavailable or ambiguous');
  const authority = authorities[0];
  const watch = definition.watches?.find((entry) => entry.id === authority.watch);
  if (watch === undefined) throw new Error('Configured review watch is unavailable');
  return watch;
}

function configuredReviewDefinition(definitions: WorkflowDefinitionRegistry, name: WorkflowName) {
  const review = definitions.currentDefinition(name);
  if (
    review.definition.stages[review.definition.entry]!.execution?.workspace !==
    WorkspaceMode.ReadOnly
  )
    throw new Error('Configured review entry must use a read-only workspace');
  if (
    Object.values(review.definition.stages).some(
      (stage) => stage.execution?.workspace === WorkspaceMode.Branch,
    )
  )
    throw new Error('Configured recovery review must not contain branch work');
  return review;
}

async function commitRequest(
  repository: OrchestrationRepository,
  input: {
    id: WorkflowInstanceId;
    sequence: number;
    key: string;
    triggerId: string;
    request: DelegationReviewRefresh;
  },
  context: CommandContext,
) {
  const { id, sequence, key, triggerId, request } = input;
  try {
    await repository.append(id, sequence, [
      delegationDraft(
        context,
        key,
        {
          eventType: Event.DelegationReviewRefreshRequested,
          payload: request,
        },
        id,
      ),
    ]);
  } catch (error) {
    if (!(error instanceof WrongExpectedSequenceError)) throw error;
    const winner = (await repository.history(id)).events.find(
      ({ event }) => event.eventId === triggerId,
    )?.event;
    if (winner?.eventType === Event.DelegationReviewRefreshRequested) return winner.payload;
    throw new Error('Child changed concurrently; inspect and retry recovery', { cause: error });
  }
  return request;
}
