import { parseIssueStateRecord } from '../domain/schema.js';
import type { EventEnvelope, IssueStateRecord } from '../domain/types.js';

function stageFromLabels(labels: string[]): IssueStateRecord['wake']['stage'] {
  if (labels.includes('wake:blocked')) {
    return 'blocked';
  }

  if (labels.includes('wake:refined')) {
    return 'refined';
  }

  if (labels.includes('wake:active')) {
    return 'active';
  }

  if (labels.includes('wake:done')) {
    return 'done';
  }

  if (labels.includes('wake:failed')) {
    return 'failed';
  }

  return 'queue';
}

function createProjectionFromIssueEvent(event: EventEnvelope): IssueStateRecord | null {
  const issue =
    event.sourceEventType === 'ticket.upsert'
      ? event.payload.ticket
      : event.payload.issue;

  if (issue === undefined || typeof issue !== 'object' || issue === null) {
    return null;
  }

  return parseIssueStateRecord({
    schemaVersion: 1,
    workItemKey: event.workItemKey,
    issue,
    wake: {
      stage: stageFromLabels(
        Array.isArray((issue as { labels?: unknown }).labels)
          ? ((issue as { labels: string[] }).labels)
          : [],
      ),
      stageHistory: [],
      recentEventIds: [event.eventId],
      syncedAt: event.ingestedAt,
    },
    context: {},
  });
}

function applyEvent(
  current: IssueStateRecord | null,
  event: EventEnvelope,
): IssueStateRecord | null {
  if (
    event.sourceEventType === 'fake.issue.upsert' ||
    event.sourceEventType === 'ticket.upsert'
  ) {
    const next = createProjectionFromIssueEvent(event);
    if (next === null) {
      return current;
    }

    if (current === null) {
      return next;
    }

    // Once a projection exists, wake.run.completed events own stage transitions.
    // Re-deriving stage from labels here would regress it to 'queue' whenever the
    // issue is re-synced (e.g. GitHub bumps updatedAt when Wake posts its own
    // status comment), producing an infinite refine loop.
    return parseIssueStateRecord({
      ...current,
      issue: next.issue,
      wake: {
        ...current.wake,
        syncedAt: event.ingestedAt,
        recentEventIds: [...current.wake.recentEventIds, event.eventId].slice(-10),
      },
    });
  }

  if (current === null) {
    return null;
  }

  if (
    event.sourceEventType === 'fake.issue.comment.created' ||
    event.sourceEventType === 'ticket.comment.created' ||
    event.sourceEventType === 'ticket.comment.updated'
  ) {
    const comment = event.payload.comment;
    if (comment === undefined || typeof comment !== 'object' || comment === null) {
      return current;
    }

    const isWakeAuthored = Boolean(event.derivedHints?.wakeAuthoredComment);
    const isBotAuthored = Boolean(event.derivedHints?.botAuthoredComment);
    const nextComment = {
      ...(comment as Record<string, unknown>),
      isWakeAuthored,
      isBotAuthored,
    };
    const existingComments = current.comments.filter(
      (entry) => entry.id !== String((comment as { id?: unknown }).id),
    );

    // A human reply is how an owner unblocks a blocked run (per the
    // "resume to understand; comment to unblock" flow). Route back to
    // whichever stage lets the next tick resume where it left off: a
    // block during 'implement' should retry implement (stage 'refined'),
    // not redo the read-only 'refine' stage and abandon the in-progress
    // branch/workspace.
    const unblocked =
      (current.wake.stage === 'blocked' || current.wake.stage === 'failed') &&
      !isWakeAuthored &&
      !isBotAuthored;
    const blockedFromAction = current.context.blockedFromAction;
    const unblockStage = blockedFromAction === 'implement' ? 'refined' : 'queue';

    return parseIssueStateRecord({
      ...current,
      comments: [...existingComments, nextComment],
      latestComment: nextComment,
      wake: {
        ...current.wake,
        stage: unblocked ? unblockStage : current.wake.stage,
        syncedAt: event.ingestedAt,
        recentEventIds: [...current.wake.recentEventIds, event.eventId].slice(-10),
        ...(unblocked
          ? {
              stageHistory: [
                ...current.wake.stageHistory,
                {
                  stage: unblockStage,
                  changedAt: event.occurredAt,
                  reason: 'human-reply-unblocked',
                },
              ],
            }
          : {}),
      },
    });
  }

  if (event.sourceEventType === 'wake.run.completed') {
    const payload = event.payload as {
      action?: string;
      nextStage?: IssueStateRecord['wake']['stage'];
      runId?: string;
      sessionId?: string;
      workspacePath?: string;
      reason?: string;
      handledCommentId?: string;
      handledIssueUpdatedAt?: string;
    };

    return parseIssueStateRecord({
      ...current,
      context: {
        ...current.context,
        ...(payload.handledCommentId === undefined
          ? {}
          : { lastHandledCommentId: payload.handledCommentId }),
        ...(payload.handledIssueUpdatedAt === undefined
          ? {}
          : { lastHandledIssueUpdatedAt: payload.handledIssueUpdatedAt }),
        // Remembered so a later human reply can route an unblocked issue
        // back to the stage that lets the same action resume, instead of
        // always restarting from 'refine'.
        ...((
          payload.nextStage === 'blocked' || payload.nextStage === 'failed'
        ) && payload.action !== undefined
          ? { blockedFromAction: payload.action }
          : {}),
      },
      wake: {
        ...current.wake,
        stage: payload.nextStage ?? current.wake.stage,
        lastRunId: payload.runId ?? current.wake.lastRunId,
        sessionId: payload.sessionId ?? current.wake.sessionId,
        workspacePath: payload.workspacePath ?? current.wake.workspacePath,
        syncedAt: event.ingestedAt,
        stageHistory: [
          ...current.wake.stageHistory,
          {
            stage: payload.nextStage ?? current.wake.stage,
            changedAt: event.occurredAt,
            reason: payload.reason ?? event.sourceEventType,
          },
        ],
        recentEventIds: [...current.wake.recentEventIds, event.eventId].slice(-10),
      },
    });
  }

  return parseIssueStateRecord({
    ...current,
    wake: {
      ...current.wake,
      syncedAt: event.ingestedAt,
      recentEventIds: [...current.wake.recentEventIds, event.eventId].slice(-10),
    },
  });
}

export function createProjectionUpdater(deps: {
  stateStore: ReturnType<typeof import('../adapters/fs/state-store.js').createStateStore>;
}) {
  return {
    async rebuildFromEvents(events: EventEnvelope[]): Promise<void> {
      const grouped = new Map<string, EventEnvelope[]>();

      for (const event of events) {
        const bucket = grouped.get(event.workItemKey) ?? [];
        bucket.push(event);
        grouped.set(event.workItemKey, bucket);
      }

      for (const workItemEvents of grouped.values()) {
        const ordered = [...workItemEvents].sort((left, right) =>
          left.occurredAt.localeCompare(right.occurredAt),
        );

        const firstEvent = ordered[0];
        let projection =
          firstEvent?.sourceRefs.repo !== undefined &&
          firstEvent.sourceRefs.issueNumber !== undefined
            ? await deps.stateStore.readIssueState(
                firstEvent.sourceRefs.repo,
                firstEvent.sourceRefs.issueNumber,
              )
            : null;

        for (const event of ordered) {
          projection = applyEvent(projection, event);
        }

        if (projection !== null) {
          await deps.stateStore.writeIssueState(projection);
        }
      }
    },
  };
}
