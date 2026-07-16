import {
  CORRELATION_PRIMARY_CONFLICT_EVENT,
  CORRELATION_REGISTERED_EVENT,
  CORRELATION_RETRACTED_EVENT,
  parseIssueStateRecord,
} from '../domain/schema.js';
import { doneRunnerSentinel, stageFromLabels } from '../domain/stages.js';
import type {
  CorrelatedResource,
  CorrelationRegisteredPayload,
  CorrelationRetractedPayload,
  EventEnvelope,
  IssueStateRecord,
} from '../domain/types.js';
import { createEventEnvelope } from '../lib/event-log.js';
import type { ResourceIndex } from './contracts.js';

/**
 * Minimal in-memory default so createProjectionUpdater/createTickRunner stay
 * usable without a caller wiring a real index in (mainly existing tests that
 * predate the correlation registry and don't exercise it). core/ must never
 * import a concrete adapter (src/adapters/fs/resource-index.ts) — this is a
 * self-contained fallback, not that adapter. Production always gets the real,
 * disk-backed index via main.ts's buildRuntime.
 */
export function createInMemoryResourceIndex(): ResourceIndex {
  const entries = new Map<string, string>();
  return {
    async resolve(resourceUri: string) {
      return entries.get(resourceUri);
    },
    async register(resourceUri: string, workItemKey: string) {
      entries.set(resourceUri, workItemKey);
    },
    async retract(resourceUri: string) {
      entries.delete(resourceUri);
    },
    async replaceAll(next: ReadonlyMap<string, string>) {
      entries.clear();
      for (const [resourceUri, workItemKey] of next) {
        entries.set(resourceUri, workItemKey);
      }
    },
  };
}

type ApplyEventCtx = {
  resourceIndex: ResourceIndex;
  appendEvent: (event: EventEnvelope) => Promise<EventEnvelope>;
};

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

async function applyEvent(
  current: IssueStateRecord | null,
  event: EventEnvelope,
  ctx: ApplyEventCtx,
): Promise<IssueStateRecord | null> {
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

  // Purely an audit record; must never affect projection state, so a full
  // event replay produces byte-identical output whether or not this
  // synthesized event happens to be included in the batch being folded
  // (it's created as a fold side effect, not iterated over on the original
  // pass, but is naturally present on a later full replay).
  if (event.sourceEventType === CORRELATION_PRIMARY_CONFLICT_EVENT) {
    return current;
  }

  if (event.sourceEventType === CORRELATION_REGISTERED_EVENT) {
    const payload = event.payload as unknown as CorrelationRegisteredPayload;
    let relation = payload.relation;

    if (relation === 'primary') {
      const incumbent = await ctx.resourceIndex.resolve(payload.resourceUri);
      if (incumbent !== undefined && incumbent !== current.workItemKey) {
        // One primary per uri (ADR 0001 §6): the second claimant folds to
        // secondary and a conflict is recorded naming the incumbent.
        // Promotion requires the incumbent to retract first — never let the
        // second registration silently steal the uri.
        relation = 'secondary';
        await ctx.appendEvent(createEventEnvelope({
          eventId: `${event.eventId}-primary-conflict`,
          workItemKey: current.workItemKey,
          streamScope: 'work-item',
          direction: 'internal',
          sourceSystem: 'wake',
          sourceEventType: CORRELATION_PRIMARY_CONFLICT_EVENT,
          sourceRefs: event.sourceRefs,
          occurredAt: event.occurredAt,
          ingestedAt: event.ingestedAt,
          trigger: 'context-only',
          payload: {
            resourceUri: payload.resourceUri,
            incumbentWorkItemKey: incumbent,
          },
        }));
      } else {
        await ctx.resourceIndex.register(payload.resourceUri, current.workItemKey);
      }
    }

    const entry: CorrelatedResource = {
      resourceUri: payload.resourceUri,
      role: payload.role,
      relation,
      provenance: payload.provenance,
      ...(payload.registeredBy === undefined ? {} : { registeredBy: payload.registeredBy }),
      registeredAt: event.occurredAt,
    };

    const currentCorrelatedResources = current.correlatedResources ?? [];
    const existingIndex = currentCorrelatedResources.findIndex(
      (resource) => resource.resourceUri === payload.resourceUri,
    );
    const correlatedResources =
      existingIndex === -1
        ? [...currentCorrelatedResources, entry]
        : currentCorrelatedResources.map((resource, index) =>
            index === existingIndex ? entry : resource,
          );

    return parseIssueStateRecord({
      ...current,
      correlatedResources,
      wake: {
        ...current.wake,
        syncedAt: event.ingestedAt,
        recentEventIds: [...current.wake.recentEventIds, event.eventId].slice(-10),
      },
    });
  }

  if (event.sourceEventType === CORRELATION_RETRACTED_EVENT) {
    const payload = event.payload as unknown as CorrelationRetractedPayload;
    const currentCorrelatedResources = current.correlatedResources ?? [];
    const existing = currentCorrelatedResources.find(
      (resource) => resource.resourceUri === payload.resourceUri,
    );

    if (existing?.relation === 'primary') {
      const owner = await ctx.resourceIndex.resolve(payload.resourceUri);
      if (owner === current.workItemKey) {
        await ctx.resourceIndex.retract(payload.resourceUri);
      }
    }

    return parseIssueStateRecord({
      ...current,
      correlatedResources: currentCorrelatedResources.filter(
        (resource) => resource.resourceUri !== payload.resourceUri,
      ),
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
      syncedAt: event.ingestedAt,
      recentEventIds: [...current.wake.recentEventIds, event.eventId].slice(-10),
    },
  });
}

export function createProjectionUpdater(deps: {
  stateStore: ReturnType<typeof import('../adapters/fs/state-store.js').createStateStore>;
  resourceIndex?: ResourceIndex;
}) {
  const applyEventCtx: ApplyEventCtx = {
    resourceIndex: deps.resourceIndex ?? createInMemoryResourceIndex(),
    appendEvent: (event) => deps.stateStore.appendEventEnvelope(event),
  };

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
          projection = await applyEvent(projection, event, applyEventCtx);
        }

        if (projection !== null) {
          await deps.stateStore.writeIssueState(projection);
        }
      }
    },
  };
}
