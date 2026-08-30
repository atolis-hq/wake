import { z } from 'zod';
import { ActivityOutcomeKind } from '../../../activities/index.js';
import { runId, RunStatus, type RunRepository } from '../../../execution/index.js';
import {
  ApprovalAuthorityKind,
  WatchGateVerdictSignal,
  watchId,
  type OrchestrationService,
  type WatchId,
  type WorkflowInstanceId,
  type WorkflowInstanceView,
} from '../../../orchestration/index.js';
import type { GitHubAdapterEventOf, GitHubEventType } from '../contracts/events.js';
import { commandContext } from './inbound-context.js';

type CommentObservedEvent = GitHubAdapterEventOf<typeof GitHubEventType.CommentObserved>;

const markerSchema = z
  .object({
    wake: z
      .object({
        watchGateVerdict: z
          .object({
            runId: z.string().min(1),
            outcome: z.enum(['DONE', 'REJECTED', 'BLOCKED', 'FAILED']),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

function extractMarker(body: string): { readonly runId: string; readonly outcome: string } | null {
  for (const match of body.matchAll(/```json\s*([\s\S]*?)```/g)) {
    if (match[1] === undefined) continue;
    try {
      const parsed = markerSchema.safeParse(JSON.parse(match[1]));
      if (parsed.success) return parsed.data.wake.watchGateVerdict;
    } catch {
      // Other JSON fences are ordinary comment content, not necessarily Wake markers.
    }
  }
  return null;
}

function translateOutcome(
  outcome: string,
): typeof ActivityOutcomeKind.Done | typeof ActivityOutcomeKind.Rejected | null {
  if (outcome === 'DONE') return ActivityOutcomeKind.Done;
  if (outcome === 'REJECTED') return ActivityOutcomeKind.Rejected;
  return null;
}

export async function applyWatchGateVerdictSignal(input: {
  readonly event: CommentObservedEvent;
  readonly runs: RunRepository | undefined;
  readonly orchestration: OrchestrationService | undefined;
}): Promise<void> {
  const { event, runs, orchestration } = input;
  if (runs === undefined || orchestration === undefined) return;
  const marker = extractMarker(event.event.payload.body);
  if (marker === null) return;
  const outcome = translateOutcome(marker.outcome);
  if (outcome === null) return;

  const verdict = await verifyWatchGateVerdict({ marker, outcome, runs, orchestration });
  if (verdict === null) return;

  await orchestration.acceptSignal(
    verdict.parentWorkflowInstanceId,
    {
      kind: WatchGateVerdictSignal,
      outcome: verdict.outcome,
      authority: { kind: ApprovalAuthorityKind.Watch, watch: verdict.childWatchId },
      actorId: event.event.payload.actor.id,
      actorDecision: { authorized: true, evidenceId: event.event.eventId },
      providerEventId: event.event.eventId,
    },
    commandContext(event),
  );
}

async function verifyWatchGateVerdict(input: {
  readonly marker: { readonly runId: string; readonly outcome: string };
  readonly outcome: typeof ActivityOutcomeKind.Done | typeof ActivityOutcomeKind.Rejected;
  readonly runs: RunRepository;
  readonly orchestration: OrchestrationService;
}): Promise<{
  readonly parentWorkflowInstanceId: WorkflowInstanceId;
  readonly outcome: typeof ActivityOutcomeKind.Done | typeof ActivityOutcomeKind.Rejected;
  readonly childWatchId: WatchId;
} | null> {
  const { marker, outcome, runs, orchestration } = input;
  const run = (await runs.load(runId(marker.runId))).view;
  if (run === null) return null;
  if (run.status !== RunStatus.Succeeded || run.outcome?.kind !== outcome) return null;

  const workflows = await orchestration.listAll();
  const child = workflows.find(
    (workflow) => workflow.workflowInstanceId === run.workflowInstanceId,
  );
  if (child?.parentWorkflowInstanceId === undefined || child.watchId === undefined) return null;
  const childWatchId = watchId(child.watchId);
  const parent = workflows.find(
    (workflow) => workflow.workflowInstanceId === child.parentWorkflowInstanceId,
  );
  if (!isWaitingForChildWatch(parent, childWatchId)) return null;

  return { parentWorkflowInstanceId: child.parentWorkflowInstanceId, outcome, childWatchId };
}

function isWaitingForChildWatch(parent: WorkflowInstanceView | undefined, childWatchId: WatchId) {
  return (
    parent?.waitingFor?.signalKind === WatchGateVerdictSignal &&
    parent.waitingFor.from?.some(
      (authority) =>
        authority.kind === ApprovalAuthorityKind.Watch && authority.watch === childWatchId,
    ) === true
  );
}
