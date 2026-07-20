import {
  CORRELATION_PRIMARY_CONFLICT_EVENT,
  CORRELATION_REGISTERED_EVENT,
  CORRELATION_RETRACTED_EVENT,
  UNRESOLVED_WORK_ITEM_KEY,
  parseIssueStateRecord,
} from '../domain/schema.js';
import { doneRunnerSentinel, stageFromLabels } from '../domain/stages.js';
import {
  builtInDefaultWorkflowDefinition,
  defaultWorkflowName,
  selectWorkflowForEvent,
  workflowStageVocabulary,
} from '../domain/workflows.js';
import { isCustomCommandAction } from '../domain/custom-commands.js';
import type {
  CorrelatedResource,
  CorrelationRegisteredPayload,
  CorrelationRetractedPayload,
  EventEnvelope,
  IssueStateRecord,
  WakeConfig,
} from '../domain/types.js';
import { createEventEnvelope } from '../lib/event-log.js';
import type { ResourceIndex } from './contracts.js';

type ApplyEventCtx = {
  resourceIndex: ResourceIndex;
  appendEvent: (event: EventEnvelope) => Promise<EventEnvelope>;
};

const WORKFLOW_SELECTED_EVENT = 'wake.workflow.selected';

function stringArrayFromPayload(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function configuredStagesForLabels(config?: WakeConfig): string[] | undefined {
  if (config === undefined) {
    return workflowStageVocabulary(builtInDefaultWorkflowDefinition);
  }

  const workflow = config.workflows[defaultWorkflowName(config)];
  return workflow === undefined ? undefined : workflowStageVocabulary(workflow);
}

function createProjectionFromIssueEvent(
  event: EventEnvelope,
  config?: WakeConfig,
): IssueStateRecord | null {
  const issue =
    event.sourceEventType === 'ticket.upsert' ? event.payload.ticket : event.payload.issue;

  if (issue === undefined || typeof issue !== 'object' || issue === null) {
    return null;
  }

  const labels = Array.isArray((issue as { labels?: unknown }).labels)
    ? (issue as { labels: string[] }).labels
    : [];

  return parseIssueStateRecord({
    schemaVersion: 1,
    workItemKey: event.workItemKey,
    origin: event.sourceSystem,
    issue,
    wake: {
      stage: stageFromLabels(labels, configuredStagesForLabels(config)) ?? 'queue',
      stageHistory: [],
      recentEventIds: [event.eventId],
      syncedAt: event.ingestedAt,
    },
    context: {},
  });
}

async function pinSelectedWorkflow(
  projection: IssueStateRecord,
  event: EventEnvelope,
  ctx: ApplyEventCtx,
  config?: WakeConfig,
): Promise<IssueStateRecord> {
  const context = projection.context as Record<string, unknown>;
  if (config === undefined || typeof context.workflow === 'string') {
    return projection;
  }

  const workflow = selectWorkflowForEvent(event, config);
  if (workflow === null) {
    return projection;
  }

  const selectedEvent = await ctx.appendEvent(
    createEventEnvelope({
      eventId: `workflow-selected-${projection.workItemKey}`,
      workItemKey: projection.workItemKey,
      streamScope: 'work-item',
      direction: 'internal',
      sourceSystem: 'wake',
      sourceEventType: WORKFLOW_SELECTED_EVENT,
      sourceRefs: event.sourceRefs,
      occurredAt: event.occurredAt,
      ingestedAt: event.ingestedAt,
      trigger: 'context-only',
      payload: {
        workflow,
        selectedFromEventId: event.eventId,
      },
    }),
  );

  return applyEvent(projection, selectedEvent, ctx, config) as Promise<IssueStateRecord>;
}

async function applyEvent(
  current: IssueStateRecord | null,
  event: EventEnvelope,
  ctx: ApplyEventCtx,
  config?: WakeConfig,
): Promise<IssueStateRecord | null> {
  // The shared sentinel for events whose resource failed mint qualification
  // (tick-runner.ts's resolveInboundEvent, spec D1'). These are durable and
  // inspectable via the event log but must never materialize a projection —
  // otherwise every unqualified ticket.upsert/fake.issue.upsert would create
  // one here on its first sighting (current === null), the same as a real
  // mint, defeating the entire point of the gate. `current` is always null
  // for this key (readIssueState(UNRESOLVED_WORK_ITEM_KEY) never has a file
  // to read), so returning it unchanged is equivalent to "no projection".
  if (event.workItemKey === UNRESOLVED_WORK_ITEM_KEY) {
    return current;
  }

  if (event.sourceEventType === 'fake.issue.upsert' || event.sourceEventType === 'ticket.upsert') {
    const next = createProjectionFromIssueEvent(event, config);
    if (next === null) {
      return current;
    }

    if (current === null) {
      return pinSelectedWorkflow(next, event, ctx, config);
    }

    const nextStageFromLabels = stageFromLabels(
      next.issue.labels,
      configuredStagesForLabels(config),
    );
    const shouldReconcileStage =
      nextStageFromLabels !== undefined && nextStageFromLabels !== current.wake.stage;

    const updated = parseIssueStateRecord({
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
    return pinSelectedWorkflow(updated, event, ctx, config);
  }

  if (current === null) {
    return null;
  }

  if (event.sourceEventType === WORKFLOW_SELECTED_EVENT) {
    const workflow = event.payload.workflow;
    if (typeof workflow !== 'string') {
      return current;
    }

    return parseIssueStateRecord({
      ...current,
      context: {
        ...current.context,
        workflow,
      },
      wake: {
        ...current.wake,
        syncedAt: event.ingestedAt,
        recentEventIds: [...current.wake.recentEventIds, event.eventId].slice(-10),
      },
    });
  }

  if (
    event.sourceEventType === 'fake.issue.comment.created' ||
    event.sourceEventType === 'ticket.comment.created' ||
    event.sourceEventType === 'ticket.comment.updated' ||
    event.sourceEventType === 'pr.comment.created' ||
    event.sourceEventType === 'pr.review.created' ||
    event.sourceEventType === 'pr.review-comment.created' ||
    event.sourceEventType === 'pr.checks.failed'
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
      blockReason?: string;
    };

    // Clear the session when the stage moves forward (new action needed) or the
    // run failed outright. Keep it for BLOCKED so the same action can resume
    // the in-progress session after a human replies.
    const isForwardProgression =
      payload.nextStage !== undefined && payload.nextStage !== current.wake.stage;
    const stageChanged =
      payload.nextStage !== undefined && payload.nextStage !== current.wake.stage;
    const isFailed = payload.sentinel === 'FAILED';
    const isCompletedCustomCommand =
      payload.action !== undefined &&
      payload.sentinel === doneRunnerSentinel &&
      config !== undefined &&
      isCustomCommandAction(payload.action, config);
    const shouldClearSession = isForwardProgression || isFailed;
    const nextContext: Record<string, unknown> = {
      ...current.context,
      lastFailureClass: payload.failureClass,
      ...(payload.handledCommentId === undefined
        ? {}
        : { lastHandledCommentId: payload.handledCommentId }),
      ...(payload.sentinel === undefined || isCompletedCustomCommand
        ? {}
        : { lastRunSentinel: payload.sentinel }),
      ...(payload.action === undefined || isCompletedCustomCommand
        ? {}
        : { lastRunAction: payload.action }),
      ...(payload.sentinel === doneRunnerSentinel &&
      payload.action !== undefined &&
      !isCompletedCustomCommand
        ? { lastCompletedAction: payload.action }
        : {}),
      // Remembered so the approval path knows which action to resume or
      // skip when a human posts /approved.
      ...(payload.sentinel === 'AWAITING_APPROVAL' && payload.action !== undefined
        ? { pendingApprovalAction: payload.action }
        : {}),
    };

    if (payload.sentinel === 'BLOCKED' || payload.sentinel === 'FAILED') {
      nextContext.blockedFromStage = current.wake.stage;
    } else if (payload.sentinel !== undefined) {
      delete nextContext.blockedFromStage;
    }

    return parseIssueStateRecord({
      ...current,
      context: nextContext,
      wake: {
        ...current.wake,
        stage: payload.nextStage ?? current.wake.stage,
        lastRunId: payload.runId ?? current.wake.lastRunId,
        sessionId: shouldClearSession ? undefined : (payload.sessionId ?? current.wake.sessionId),
        sessionCli: shouldClearSession
          ? undefined
          : (payload.sessionCli ?? current.wake.sessionCli),
        workspacePath: payload.workspacePath ?? current.wake.workspacePath,
        blockReason: payload.blockReason ?? current.wake.blockReason,
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
          commentIds: Array.from(new Set([...current.wake.expectedEcho.commentIds, commentId])),
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

    // ADR 0001 §6 is a *downgrade* rule, and only a downgrade rule: "a second
    // `primary` registration on a claimed URI is downgraded to `secondary` and
    // a warning event appended." It says nothing about promoting a requested
    // `secondary`, and §5 lists `relation` as a payload input — so a requested
    // `secondary` must stay `secondary`. Folding a requested `secondary` up to
    // `primary` would silently rewrite the declaration the event made, and the
    // downgrade rule is a corruption guard, not a merge rule — it exists to
    // stop a second claim on a URI, not to promote unclaimed ones.
    //
    // (No shipped caller declares `secondary` yet — `wake correlate` hardcodes
    // `primary`. The rule follows the spec's payload contract, which is the
    // standard here; an emitter is #82's scope.)
    //
    //   requested primary + held by ANOTHER work item -> secondary + conflict
    //   requested primary + unclaimed / held by THIS   -> primary, indexed
    //   requested secondary                            -> secondary, unindexed
    //
    // A requested-secondary never touching the index is by design, not an
    // orphan: the index is primary-only (ADR §5 — the resolver stamps the
    // *primary* work item's canonical key), so a secondary has nothing to
    // register. Promotion still requires the incumbent to retract first —
    // never let a second registration silently steal a uri.
    const incumbent = await ctx.resourceIndex.resolve(payload.resourceUri);
    const heldByAnotherWorkItem = incumbent !== undefined && incumbent !== current.workItemKey;
    const relation: CorrelatedResource['relation'] =
      payload.relation === 'primary' && !heldByAnotherWorkItem ? 'primary' : 'secondary';

    if (relation === 'primary') {
      await ctx.resourceIndex.register(payload.resourceUri, current.workItemKey);
    } else {
      if (payload.relation === 'primary') {
        await ctx.appendEvent(
          createEventEnvelope({
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
          }),
        );
      }

      // Coherent inverse of the retraction gate below: a registration that
      // folds to non-primary must never leave the index stranded crediting
      // this work item. This is reachable as a genuine *self-demotion* — a
      // work item that holds a uri primary and then registers it `secondary`
      // — where leaving the index pointing at us would contradict our own
      // correlatedResources[] entry. Gated on actual index ownership, so the
      // ordinary requested-secondary-on-an-unclaimed-uri case (owner
      // undefined) correctly leaves the index untouched (finding B).
      const owner = await ctx.resourceIndex.resolve(payload.resourceUri);
      if (owner === current.workItemKey) {
        await ctx.resourceIndex.retract(payload.resourceUri);
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

    const currentCorrelatedResources = current.correlatedResources;
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
    const currentCorrelatedResources = current.correlatedResources;

    // Retract whenever the index currently credits this work item —
    // regardless of the locally stored relation — so the registration and
    // retraction gates are coherent inverses across a demotion. Gating this
    // on `existing?.relation === 'primary'` (the locally folded relation at
    // *registration* time) can strand the index pointing at a work item that
    // no longer holds the resource once that relation has drifted, which is
    // exactly the identity-critical path `resolve()` depends on (finding B).
    const owner = await ctx.resourceIndex.resolve(payload.resourceUri);
    if (owner === current.workItemKey) {
      await ctx.resourceIndex.retract(payload.resourceUri);
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
  // Required, not defaulted: this is correlation state, and CLAUDE.md forbids
  // caching durable state in process memory between ticks. A default here
  // would (a) silently evaporate the one-primary guarantee across a process
  // restart and (b) let a future caller who forgets to wire the real index
  // get no failure at all — just resolve() -> undefined, which downstream
  // means "mint a new work item". Tests pass an explicit fake
  // (adapters/fake/fake-resource-index.ts); production always passes the
  // real, disk-backed index via main.ts's buildRuntime.
  resourceIndex: ResourceIndex;
  config?: WakeConfig;
}) {
  const applyEventCtx: ApplyEventCtx = {
    resourceIndex: deps.resourceIndex,
    appendEvent: (event) => deps.stateStore.appendEventEnvelope(event),
  };

  return {
    async rebuildFromEvents(events: EventEnvelope[]): Promise<void> {
      // Correlation-index-affecting events (wake.correlation.registered in
      // particular) must be folded in *globally* ordered time, not grouped by
      // workItemKey and folded per-group. resourceIndex is shared/global
      // across all work items, so whichever group happens to be visited first
      // (Map insertion order — i.e. whichever work item's earliest event
      // happens to appear first in the input array) would otherwise decide
      // who wins a primary claim, independent of when the registration events
      // actually occurred. That makes a full replay (this function, called
      // with every event) diverge from the live/incremental fold (this
      // function, called with one new event at a time as it happens) for any
      // two work items whose creation order and registration order disagree
      // — silently handing resumption for a resource to the wrong work item
      // after `rm -rf state/` + replay. Sorting once, globally, by
      // (ingestedAt, eventId) and folding in that single pass keeps replay
      // and live agreeing by construction, for both the index and the
      // per-work-item projection fold (a global sort is still a valid order
      // for each individual work item's own events, since it's a stable
      // sort over a total order that's consistent with each event's own
      // ingestedAt).
      // Sort is stable (ES2019+), so events sharing an ingestedAt keep their
      // input order — which is append/arrival order, the same order the live
      // fold saw them in. Do not add a tie-break on eventId: ids are not
      // chronological, so that would reorder same-timestamp events within a
      // work item against the order they actually happened.
      const ordered = [...events].sort((left, right) =>
        left.ingestedAt.localeCompare(right.ingestedAt),
      );

      const projections = new Map<string, IssueStateRecord | null>();
      const touchedWorkItemKeys: string[] = [];

      for (const event of ordered) {
        if (!projections.has(event.workItemKey)) {
          touchedWorkItemKeys.push(event.workItemKey);
          projections.set(
            event.workItemKey,
            await deps.stateStore.readIssueState(event.workItemKey),
          );
        }

        const current = projections.get(event.workItemKey) ?? null;
        projections.set(
          event.workItemKey,
          await applyEvent(current, event, applyEventCtx, deps.config),
        );
      }

      for (const workItemKey of touchedWorkItemKeys) {
        const projection = projections.get(workItemKey) ?? null;
        if (projection !== null) {
          await deps.stateStore.writeIssueState(projection);
        }
      }
    },
  };
}
