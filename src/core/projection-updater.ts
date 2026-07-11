import { parseIssueStateRecord } from '../domain/schema.js';
import { doneRunnerSentinel, stageFromLabels } from '../domain/stages.js';
import type { EventEnvelope, IssueStateRecord } from '../domain/types.js';

function stringArrayFromPayload(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function createProjectionFromIssueEvent(event: EventEnvelope): IssueStateRecord | null {
  const issue =
    event.sourceEventType === 'ticket.upsert'
      ? event.payload.ticket
      : event.payload.issue;

  if (issue === undefined || typeof issue !== 'object' || issue === null) {
    return null;
  }

  const labels = Array.isArray((issue as { labels?: unknown }).labels)
    ? ((issue as { labels: string[] }).labels)
    : [];

  return parseIssueStateRecord({
    schemaVersion: 1,
    workItemKey: event.workItemKey,
    origin: event.sourceSystem,
    issue,
    wake: {
      stage: stageFromLabels(labels) ?? 'queue',
      stageHistory: [],
      recentEventIds: [event.eventId],
      syncedAt: event.ingestedAt,
    },
    context: {},
  });
}

function sourceFromWorkItemKey(workItemKey: string): string | undefined {
  const marker = workItemKey.indexOf(':');
  return marker > 0 ? workItemKey.slice(0, marker) : undefined;
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

    const nextStageFromLabels = stageFromLabels(next.issue.labels);
    const shouldReconcileStage =
      nextStageFromLabels !== undefined && nextStageFromLabels !== current.wake.stage;

    return parseIssueStateRecord({
      ...current,
      origin: current.origin,
      issue: next.issue,
      wake: {
        ...current.wake,
        ...(shouldReconcileStage ? { stage: nextStageFromLabels } : {}),
        syncedAt: event.ingestedAt,
        stageHistory: shouldReconcileStage
          ? [
              ...current.wake.stageHistory,
              {
                stage: nextStageFromLabels,
                changedAt: event.occurredAt,
                reason: 'github-label-sync',
              },
            ]
          : current.wake.stageHistory,
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

    const isBotAuthored = Boolean(event.derivedHints?.botAuthoredComment);
    const nextComment = {
      ...(comment as Record<string, unknown>),
      isBotAuthored,
    };
    const existingComments = current.comments.filter(
      (entry) => entry.id !== String((comment as { id?: unknown }).id),
    );

    return parseIssueStateRecord({
      ...current,
      comments: [...existingComments, nextComment],
      latestComment: nextComment,
      wake: {
        ...current.wake,
        syncedAt: event.ingestedAt,
        recentEventIds: [...current.wake.recentEventIds, event.eventId].slice(-10),
      },
    });
  }

  if (event.sourceEventType === 'wake.run.claimed') {
    const payload = event.payload as {
      action?: string;
      claimedStage?: IssueStateRecord['wake']['stage'];
    };

    if (payload.claimedStage === undefined) {
      return parseIssueStateRecord({
        ...current,
        wake: {
          ...current.wake,
          syncedAt: event.ingestedAt,
          recentEventIds: [...current.wake.recentEventIds, event.eventId].slice(-10),
        },
      });
    }

    return parseIssueStateRecord({
      ...current,
      wake: {
        ...current.wake,
        stage: payload.claimedStage,
        lastRunId: event.sourceRefs.runId ?? current.wake.lastRunId,
        syncedAt: event.ingestedAt,
        stageHistory: [
          ...current.wake.stageHistory,
          {
            stage: payload.claimedStage,
            changedAt: event.occurredAt,
            reason: `run:${payload.action ?? 'unknown'}:claimed`,
          },
        ],
        recentEventIds: [...current.wake.recentEventIds, event.eventId].slice(-10),
      },
    });
  }

  if (event.sourceEventType === 'wake.run.completed') {
    const payload = event.payload as {
      action?: string;
      sentinel?: string;
      nextStage?: IssueStateRecord['wake']['stage'];
      runId?: string;
      sessionId?: string;
      sessionCli?: string;
      workspacePath?: string;
      reason?: string;
      handledCommentId?: string;
      failureClass?: string;
    };

    // Clear the session when the stage moves forward (new action needed) or the
    // run failed outright. Keep it for BLOCKED so the same action can resume
    // the in-progress session after a human replies.
    const isForwardProgression =
      payload.nextStage !== undefined &&
      payload.nextStage !== current.wake.stage;
    const stageChanged =
      payload.nextStage !== undefined && payload.nextStage !== current.wake.stage;
    const isFailed = payload.sentinel === 'FAILED';
    const shouldClearSession = isForwardProgression || isFailed;

    return parseIssueStateRecord({
      ...current,
      context: {
        ...current.context,
        lastFailureClass: payload.failureClass,
        ...(payload.handledCommentId === undefined
          ? {}
          : { lastHandledCommentId: payload.handledCommentId }),
        ...(payload.sentinel === undefined
          ? {}
          : { lastRunSentinel: payload.sentinel }),
        ...(payload.action === undefined
          ? {}
          : { lastRunAction: payload.action }),
        ...(payload.sentinel === doneRunnerSentinel && payload.action !== undefined
          ? { lastCompletedAction: payload.action }
          : {}),
        // Remembered so the approval path knows which action to resume or
        // skip when a human posts /approved.
        ...(payload.sentinel === 'AWAITING_APPROVAL' && payload.action !== undefined
          ? { pendingApprovalAction: payload.action }
          : {}),
      },
      wake: {
        ...current.wake,
        stage: payload.nextStage ?? current.wake.stage,
        lastRunId: payload.runId ?? current.wake.lastRunId,
        sessionId: shouldClearSession
          ? undefined
          : (payload.sessionId ?? current.wake.sessionId),
        sessionCli: shouldClearSession
          ? undefined
          : (payload.sessionCli ?? current.wake.sessionCli),
        workspacePath: payload.workspacePath ?? current.wake.workspacePath,
        syncedAt: event.ingestedAt,
        stageHistory: stageChanged
          ? [
              ...current.wake.stageHistory,
              {
                stage: payload.nextStage,
                changedAt: event.occurredAt,
                reason: payload.reason ?? event.sourceEventType,
              },
            ]
          : current.wake.stageHistory,
        recentEventIds: [...current.wake.recentEventIds, event.eventId].slice(-10),
      },
    });
  }

  if (event.sourceEventType === 'ticket.reply.published') {
    const commentId = event.sourceRefs.commentId;
    if (commentId === undefined) {
      return parseIssueStateRecord({
        ...current,
        wake: {
          ...current.wake,
          syncedAt: event.ingestedAt,
          recentEventIds: [...current.wake.recentEventIds, event.eventId].slice(-10),
        },
      });
    }

    return parseIssueStateRecord({
      ...current,
      wake: {
        ...current.wake,
        expectedEcho: {
          ...current.wake.expectedEcho,
          commentIds: Array.from(
            new Set([...current.wake.expectedEcho.commentIds, commentId]),
          ),
        },
        syncedAt: event.ingestedAt,
        recentEventIds: [...current.wake.recentEventIds, event.eventId].slice(-10),
      },
    });
  }

  if (event.sourceEventType === 'wake.workspace.cleaned') {
    return parseIssueStateRecord({
      ...current,
      wake: {
        ...current.wake,
        workspacePath: undefined,
        syncedAt: event.ingestedAt,
        recentEventIds: [...current.wake.recentEventIds, event.eventId].slice(-10),
      },
    });
  }

  if (event.sourceEventType === 'ticket.labels.updated') {
    const labels = stringArrayFromPayload(event.payload.labels);

    return parseIssueStateRecord({
      ...current,
      issue: {
        ...current.issue,
        labels,
      },
      wake: {
        ...current.wake,
        expectedEcho: {
          ...current.wake.expectedEcho,
          labels,
        },
        syncedAt: event.ingestedAt,
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
          left.ingestedAt.localeCompare(right.ingestedAt),
        );

        const firstEvent = ordered[0];
        let projection =
          firstEvent?.sourceRefs.repo !== undefined &&
          firstEvent.sourceRefs.issueNumber !== undefined
            ? await deps.stateStore.readIssueState(
                firstEvent.sourceRefs.repo,
                firstEvent.sourceRefs.issueNumber,
                sourceFromWorkItemKey(firstEvent.workItemKey),
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
