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
      attempts: 0,
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

    return parseIssueStateRecord({
      ...current,
      issue: next.issue,
      wake: {
        ...current.wake,
        stage: next.wake.stage,
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

    const nextComment = {
      ...(comment as Record<string, unknown>),
      isWakeAuthored: Boolean(event.derivedHints?.wakeAuthoredComment),
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

  if (event.sourceEventType === 'wake.run.completed') {
    const payload = event.payload as {
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
