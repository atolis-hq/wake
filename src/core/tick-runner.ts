import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

import { createLifecycleService } from './lifecycle-service.js';
import { createPolicyEngine } from './policy-engine.js';
import { createProjectionUpdater } from './projection-updater.js';
import type {
  AgentRunner,
  AgentRunResult,
  AgentRunTokenUsage,
  ArtifactVerifier,
  OutboundSink,
  ResourceIndex,
  UnkeyedEventEnvelope,
  WorkSource,
  WorkspaceManager,
} from './contracts.js';
import type { Clock } from '../lib/clock.js';
import { acquireFileLock } from '../lib/lock.js';
import { createWorkId } from '../lib/work-id.js';
import {
  CORRELATION_REGISTERED_EVENT,
  UNRESOLVED_WORK_ITEM_KEY,
  WORK_ITEM_CREATED_EVENT,
  parseRunnerArtifacts,
  parseRunnerResult,
} from '../domain/schema.js';
import { maxConfiguredRunnerTimeoutMs, resolveRunnerRouting } from '../domain/runner-routing.js';
import { awaitingApprovalRunnerSentinel, stageLabelForStage } from '../domain/stages.js';
import type { AgentAction, EventEnvelope, IssueStateRecord, RunRecord, WakeConfig } from '../domain/types.js';
import { createEventEnvelope } from '../lib/event-log.js';
import { branchNameForIssue } from '../domain/branch-naming.js';
import { resolveQuotaPauseUntil } from './quota-backoff.js';

type ParsedRunnerResult = ReturnType<typeof parseRunnerResult>;

// A resolved inbound event plus whether it is already on record. `persisted`
// events are folded but not re-appended (appendEventEnvelope would only re-read
// and return the identical envelope).
type ResolvedInboundEvent = { envelope: EventEnvelope; persisted: boolean };

function latestHumanCommentId(candidate: IssueStateRecord): string | undefined {
  const human = candidate.comments.filter((c) => !c.isBotAuthored);
  return human.at(-1)?.id;
}

// `latestComment` is a sticky, per-work-item field: projection-updater.ts's
// comment fold overwrites it unconditionally on every inbound comment
// (any surface) and nothing ever resets it. So it means "the last comment
// this work item has ever received," not "the comment that triggered the
// currently completing run." Several needsWakeAction trigger paths (first
// run, quota-failure retry, first refine/implement pass) complete a run
// with no fresh comment driving it at all — in those cases latestComment
// may still be pointing at an older, already-handled comment from a
// different surface (e.g. a PR) and must not be trusted as this run's
// trigger. This mirrors policy-engine.ts's needsWakeAction "is there an
// unhandled human comment" check exactly, so a comment is only treated as
// having driven this run when it's human-authored and not yet the
// candidate's own lastHandledCommentId (read from the pre-completion
// projection passed in as `candidate`/`projection`, since the completion
// event that would update lastHandledCommentId for *this* run hasn't been
// folded yet at the point this runs).
function isFreshTriggeringComment(candidate: IssueStateRecord): boolean {
  const context = candidate.context as Record<string, unknown>;
  const handledCommentId =
    typeof context.lastHandledCommentId === 'string' ? context.lastHandledCommentId : undefined;

  return (
    candidate.latestComment !== undefined &&
    !candidate.latestComment.isBotAuthored &&
    candidate.latestComment.id !== handledCommentId
  );
}

export function createTickRunner(deps: {
  clock: Clock;
  config: WakeConfig;
  stateStore: ReturnType<typeof import('../adapters/fs/state-store.js').createStateStore>;
  workSource: WorkSource;
  outboundSink?: OutboundSink;
  runner: AgentRunner;
  workspaceManager: WorkspaceManager;
  // Required — see the matching note on createProjectionUpdater's
  // resourceIndex: this is durable correlation state and must never be
  // cached in process memory across ticks or silently defaulted away.
  resourceIndex: ResourceIndex;
  // Optional: verifies agent-reported PR artifacts against the real provider
  // before they're registered as correlated resources. Undefined (e.g. no
  // GitHub source configured) means artifact claims are never trusted —
  // registerReportedArtifacts becomes a no-op rather than registering
  // unverified free text.
  artifactVerifier?: ArtifactVerifier;
}) {
  const policy = createPolicyEngine();
  const lifecycle = createLifecycleService();
  const projectionUpdater = createProjectionUpdater({
    stateStore: deps.stateStore,
    resourceIndex: deps.resourceIndex,
  });

  function extractTokenCount(tokenUsage: AgentRunTokenUsage | undefined): number | undefined {
    if (tokenUsage === undefined) {
      return undefined;
    }
    // Cache tokens dominate real usage and were previously dropped from this
    // total entirely, understating the reported figure by roughly an order of
    // magnitude (#135).
    return (
      tokenUsage.inputTokens +
      tokenUsage.outputTokens +
      (tokenUsage.cacheCreationInputTokens ?? 0) +
      (tokenUsage.cacheReadInputTokens ?? 0)
    );
  }

  function formatCostUsd(costUsd: number): string {
    return `$${costUsd.toFixed(costUsd < 1 ? 4 : 2)}`;
  }

  function formatDuration(startedAtStr: string, finishedAtStr: string): string | undefined {
    const startedAt = new Date(startedAtStr);
    const finishedAt = new Date(finishedAtStr);
    const durationMs = finishedAt.getTime() - startedAt.getTime();
    if (durationMs < 0 || !isFinite(durationMs)) return undefined;

    const totalSeconds = Math.floor(durationMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    if (minutes > 0) {
      return `${minutes}m${seconds}s`;
    }
    return `${seconds}s`;
  }

  function formatTokenCount(count: number): string {
    if (count >= 1000000) {
      return `${(count / 1000000).toFixed(1)}M`;
    }
    if (count >= 1000) {
      return `${(count / 1000).toFixed(0)}k`;
    }
    return String(count);
  }

  function createPublishIntentEvent(input: {
    projection: import('../domain/types.js').IssueStateRecord;
    runId: string;
    action: AgentAction;
    runnerResult: AgentRunResult;
    parsedRunnerResult: ParsedRunnerResult;
    sentinel: 'DONE' | 'BLOCKED' | 'FAILED' | 'AWAITING_APPROVAL';
    occurredAt: string;
    workspacePath?: string;
    startedAt: string;
  }): EventEnvelope {
    const tokenCount = extractTokenCount(input.runnerResult.tokenUsage);
    const duration = formatDuration(input.startedAt, input.occurredAt);

    return createEventEnvelope({
      eventId: `${input.runId}-publish-intent`,
      workItemKey: input.projection.workItemKey,
      streamScope: 'work-item',
      direction: 'outbound',
      sourceSystem: 'wake',
      sourceEventType: 'wake.publish.intent.requested',
      sourceRefs: {
        repo: input.projection.issue.repo,
        issueNumber: input.projection.issue.number,
        runId: input.runId,
        // Carries the triggering comment's surface (set only when the human
        // reply that woke this run came from a correlated PR/review-thread
        // resource, per the ad1cf45 comment fold) through to the sink
        // router, so createOutboundSinkRouter's kind-based routing (Task 11,
        // sink-router.ts) can send the reply back to that surface instead of
        // defaulting to the issue thread. Without this, every reply landed
        // on the origin sink regardless of which surface triggered the run.
        //
        // Gated on isFreshTriggeringComment: latestComment is sticky (see
        // that function's comment) and several run-completion paths (first
        // run, quota retry, first refine/implement pass) have no fresh
        // comment behind them at all — for those, threading the stale
        // latestComment.resourceUri would misroute the reply to whatever
        // surface last happened to comment, even long after that comment
        // was already replied to.
        ...(input.projection.latestComment?.resourceUri === undefined ||
        !isFreshTriggeringComment(input.projection)
          ? {}
          : { resourceUri: input.projection.latestComment.resourceUri }),
      },
      occurredAt: input.occurredAt,
      ingestedAt: input.occurredAt,
      trigger: 'context-only',
      payload: {
        kind: input.sentinel === 'BLOCKED'
          ? 'question'
          : input.sentinel === 'AWAITING_APPROVAL'
            ? 'approval-request'
            : input.sentinel === 'FAILED'
              ? 'failure'
              : 'status-update',
        origin: input.projection.origin ?? 'github',
        body: input.parsedRunnerResult.body,
        action: input.action,
        sentinel: input.sentinel,
        runId: input.runId,
        ...(input.runnerResult.session_id === undefined
          ? {}
          : { sessionId: input.runnerResult.session_id }),
        model: input.runnerResult.model,
        cli: input.runnerResult.cli,
        ...(input.runnerResult.routing === undefined
          ? {}
          : {
              runnerName: input.runnerResult.routing.runnerName,
              runnerKind: input.runnerResult.routing.runnerKind,
              runnerTier: input.runnerResult.routing.tier,
              runnerReason: input.runnerResult.routing.reason,
            }),
        ...(duration === undefined ? {} : { duration }),
        ...(tokenCount === undefined ? {} : { tokens: formatTokenCount(tokenCount) }),
        ...(input.runnerResult.tokenUsage?.costUsd === undefined
          ? {}
          : { cost: formatCostUsd(input.runnerResult.tokenUsage.costUsd) }),
        ...(input.workspacePath === undefined
          ? {}
          : { workspacePath: input.workspacePath }),
      },
      derivedHints: {
        stage: input.sentinel === 'DONE' ? 'done' : input.projection.wake.stage,
      },
    });
  }

  function isAwaitingApproval(projection: IssueStateRecord): boolean {
    return projection.context.lastRunSentinel === awaitingApprovalRunnerSentinel;
  }

  function statusLabelForStage(stage: import('../domain/types.js').Stage): string {
    if (stage === 'done') {
      return 'wake:status.completed';
    }

    return 'wake:status.pending';
  }

  function statusLabelForOutcome(input: {
    sentinel: 'DONE' | 'BLOCKED' | 'FAILED' | 'AWAITING_APPROVAL';
    stage: import('../domain/types.js').Stage;
  }): string {
    if (input.sentinel === 'AWAITING_APPROVAL') {
      return 'wake:status.awaiting-approval';
    }
    if (input.sentinel === 'BLOCKED') {
      return 'wake:status.blocked';
    }
    if (input.sentinel === 'FAILED') {
      return 'wake:status.failed';
    }
    return statusLabelForStage(input.stage);
  }

  function hasLabel(projection: IssueStateRecord, label: string): boolean {
    return projection.issue.labels.includes(label);
  }

  function shouldMarkPending(projection: IssueStateRecord): boolean {
    if (!policy.isEligible(projection, deps.config)) {
      return false;
    }

    if (isAwaitingApproval(projection)) {
      return policy.resolveApprovalTransition(projection) !== null;
    }

    const nextAction =
      policy.chooseAction(projection.wake.stage) ??
      policy.chooseRetryActionAfterHumanReply(projection);

    return nextAction !== null && policy.needsWakeAction(projection);
  }

  function createLabelsEvent(input: {
    projection: import('../domain/types.js').IssueStateRecord;
    runId: string;
    statusLabel: string;
    stageLabel: string;
    occurredAt: string;
  }): EventEnvelope {
    return createEventEnvelope({
      eventId: `${input.runId}-labels-${input.statusLabel.replace(/[^a-z0-9]+/gi, '-')}-${input.stageLabel.replace(/[^a-z0-9]+/gi, '-')}`,
      workItemKey: input.projection.workItemKey,
      streamScope: 'work-item',
      direction: 'outbound',
      sourceSystem: 'wake',
      sourceEventType: 'wake.labels.requested',
      sourceRefs: {
        repo: input.projection.issue.repo,
        issueNumber: input.projection.issue.number,
        runId: input.runId,
      },
      occurredAt: input.occurredAt,
      ingestedAt: input.occurredAt,
      trigger: 'context-only',
      payload: {
        statusLabel: input.statusLabel,
        stageLabel: input.stageLabel,
        origin: input.projection.origin ?? 'github',
      },
    });
  }

  // Closes the loop on #82's review feedback: rather than scrape a PR link
  // out of the agent's free text, the agent emits a `wake-artifacts` fence
  // (domain/schema.ts's parseRunnerArtifacts) and Wake verifies each claim
  // against the real provider before trusting it. No verifier configured (no
  // GitHub source) means no claim is ever trusted — this is a no-op, not a
  // silent "believe the agent" fallback.
  //
  // Uses a plain appendEventEnvelope + rebuildFromEvents pair, not
  // deliverOutboundEvent: wake.correlation.registered is not a publish-intent
  // type, so attemptDelivery's outbound sink call would be a no-op anyway —
  // this matches the same plain-append pattern used elsewhere for
  // internal-only events (see buildOriginCorrelationEvents' callers).
  async function registerReportedArtifacts(input: {
    projection: IssueStateRecord;
    runId: string;
    runnerResult: AgentRunResult;
    branch: string;
    occurredAt: string;
  }): Promise<void> {
    if (deps.artifactVerifier === undefined) {
      return;
    }

    const { artifacts } = parseRunnerArtifacts(input.runnerResult.result);
    for (const artifact of artifacts) {
      const verified = await deps.artifactVerifier.verify(artifact, {
        branch: input.branch,
        repo: input.projection.issue.repo,
      });
      if (verified === null) {
        continue;
      }

      const event = createEventEnvelope({
        eventId: `${input.runId}-artifact-${artifact.kind}-${verified.resourceUri.replace(/[^a-z0-9]+/gi, '-')}`,
        workItemKey: input.projection.workItemKey,
        streamScope: 'work-item',
        direction: 'internal',
        sourceSystem: 'wake',
        sourceEventType: CORRELATION_REGISTERED_EVENT,
        sourceRefs: { runId: input.runId },
        occurredAt: input.occurredAt,
        ingestedAt: input.occurredAt,
        trigger: 'context-only',
        payload: {
          resourceUri: verified.resourceUri,
          role: 'implementation',
          relation: 'primary',
          provenance: 'agent-reported',
          registeredBy: input.runId,
        },
      });
      const appended = await deps.stateStore.appendEventEnvelope(event);
      await projectionUpdater.rebuildFromEvents([appended]);
    }
  }

  // Events are stamped by reading the clock at the moment of stamping, never
  // from a frozen tick-start snapshot. `tickStartedAt` is the tick's *decision*
  // clock (policy/staleness), and reusing it to date events inverts them
  // against the work source's own poll-time ingestedAt — pollEvents() runs
  // after tickStartedAt is captured, so in production every polled upsert is
  // LATER than the tick's start. An event dated before the upsert that creates
  // the projection it folds into sorts ahead of it in rebuildFromEvents' global
  // replay, folds against `current === null`, and is silently dropped. Reading
  // per event also stays correct once ticks work items in parallel, where a
  // shared per-tick snapshot would tie every concurrent event on ingestedAt and
  // leave append order as the only discriminator.
  function eventStampNow(): string {
    return deps.clock.now().toISOString();
  }

  // The watchlist is every resource currently correlated to an open work
  // item, deduplicated by exact resourceUri. It is derived once per tick from
  // the pre-poll projection snapshot (see runTick's ordering note) and handed
  // to every configured WorkSource. Core never interprets these URIs — it's
  // each source's own job to recognize and filter down to the resourceUri
  // shapes it understands (e.g. the GitHub PR source only polls entries
  // starting with `github:pr:`, ignoring everything else, including its own
  // review-thread correlations) and never core's (CLAUDE.md: "Core compares
  // resourceUri strings for equality and never parses a locator").
  function deriveWatchlist(projections: IssueStateRecord[]): { resourceUri: string }[] {
    const seen = new Set<string>();
    const watch: { resourceUri: string }[] = [];

    for (const projection of projections) {
      if (projection.issue.state !== 'open') {
        continue;
      }
      for (const resource of projection.correlatedResources) {
        if (seen.has(resource.resourceUri)) {
          continue;
        }
        seen.add(resource.resourceUri);
        watch.push({ resourceUri: resource.resourceUri });
      }
    }

    return watch;
  }

  async function markPendingActionableIssues(
    projections: IssueStateRecord[],
  ): Promise<void> {
    for (const projection of projections) {
      const statusLabel = statusLabelForStage(projection.wake.stage);
      const stageLabel = stageLabelForStage(projection.wake.stage);

      if (
        !shouldMarkPending(projection) ||
        (hasLabel(projection, statusLabel) && hasLabel(projection, stageLabel))
      ) {
        continue;
      }

      await deliverOutboundEvent(
        createLabelsEvent({
          projection,
          runId: `pending-${projection.workItemKey}-${deps.clock.now().getTime()}`,
          statusLabel,
          stageLabel,
          occurredAt: eventStampNow(),
        }),
      );
    }
  }

  // Returns whichever of the two timestamps is unambiguously later, defaulting
  // to `left`. `right` wins only if it is later by BOTH the actual instant and
  // the lexicographic order rebuildFromEvents sorts on — the envelope schema is
  // `z.string().datetime({ offset: true })`, so a timestamp may legally carry a
  // non-UTC offset or differing sub-second precision, and lexicographic order
  // alone is not a reliable proxy for chronology across those formats. Falling
  // back to `left` (the source event's own exact string) is always safe: it
  // ties with that event under localeCompare, and the stable sort then preserves
  // append order, which puts the mint events after it — exactly what we need.
  function laterTimestamp(left: string, right: string): string {
    const isLater =
      Date.parse(right) > Date.parse(left) && right.localeCompare(left) > 0;
    return isLater ? right : left;
  }

  // The two internal events a mint (or a heal) appends after the source event
  // that founded a work item: wake.workitem.created, then the
  // wake.correlation.registered that claims the originating resource as this
  // work item's primary representation. Their ids are derived from the work id,
  // so re-emitting them is idempotent — appendEventEnvelope dedups on the id.
  //
  // Ordering and timestamps matter, and not only for readability. Both fold
  // against the projection the source event creates, and applyEvent drops
  // anything that folds while `current === null`. So they must never sort
  // *before* that source event in rebuildFromEvents' globally-ordered replay —
  // if they did, replay would silently discard the registration, leaving
  // correlatedResources[] empty and the index unpopulated, while the events
  // still on record stop any later tick from re-registering. Permanent,
  // self-concealing loss (Task 5, round 3). Reading the clock here is already
  // after pollEvents(), but that alone is not a guarantee: the source event's
  // ingestedAt comes from the *source's* clock, which for a real source is
  // another machine's and can legitimately run ahead of ours. Anchoring on the
  // source event's own timestamp makes the ordering hold by construction rather
  // than by clock agreement; appending the source event first means a tie
  // resolves in its favour (the sort is stable, so equal timestamps keep append
  // order).
  function buildOriginCorrelationEvents(
    workItemKey: string,
    unkeyed: UnkeyedEventEnvelope,
    resourceUri: string,
  ): EventEnvelope[] {
    const mintedAt = laterTimestamp(unkeyed.ingestedAt, eventStampNow());
    const sourceRefs = {
      ...unkeyed.sourceRefs,
      resourceUri,
    };

    const createdEvent = createEventEnvelope({
      eventId: `${workItemKey}-created`,
      workItemKey,
      streamScope: 'work-item',
      direction: 'internal',
      sourceSystem: 'wake',
      sourceEventType: WORK_ITEM_CREATED_EVENT,
      sourceRefs,
      occurredAt: mintedAt,
      ingestedAt: mintedAt,
      trigger: 'context-only',
      // The envelope's workItemKey already carries the identity.
      payload: {},
    });

    const registeredEvent = createEventEnvelope({
      eventId: `${workItemKey}-origin-correlation`,
      workItemKey,
      streamScope: 'work-item',
      direction: 'internal',
      sourceSystem: 'wake',
      sourceEventType: CORRELATION_REGISTERED_EVENT,
      sourceRefs,
      occurredAt: mintedAt,
      ingestedAt: mintedAt,
      trigger: 'context-only',
      payload: {
        resourceUri,
        role: 'representation',
        relation: 'primary',
        provenance: 'wake-created',
      },
    });

    return [createdEvent, registeredEvent];
  }

  // The central resolver (spec D1): sources name the *resource* an event came
  // from and never the work item, so between pollEvents() and the append every
  // inbound event's sourceRefs.resourceUri is resolved through the reverse
  // index to the canonical workItemKey, minting a work item on a miss. This is
  // the one mechanism — there is no founding-surface special case, and no
  // resolution is ever cached in process memory between ticks (CLAUDE.md: the
  // tick is a pure function of durable state; the index on disk *is* that
  // state).
  //
  // Each resolved event carries whether it is already `persisted`, so the
  // caller can skip re-appending it (appendEventEnvelope would only re-read it
  // and hand back the same envelope). Minting *is* registration, so a freshly
  // minted work item's correlatedResources[] is complete from its first event.
  async function resolveInboundEvent(
    unkeyed: UnkeyedEventEnvelope,
  ): Promise<ResolvedInboundEvent[]> {
    const { resourceUri } = unkeyed.sourceRefs;
    if (resourceUri === undefined) {
      // A programming error in the adapter, not a runtime condition to absorb.
      // Guessing an identity here would silently fork a duplicate work item
      // for work already in flight — exactly the corruption the reverse index
      // exists to prevent — so fail loudly instead.
      throw new Error(
        `cannot resolve inbound event ${unkeyed.eventId} from ${unkeyed.sourceSystem}: ` +
          'sourceRefs.resourceUri is required for every unkeyed source event',
      );
    }

    // An event we have already persisted was already resolved, on some earlier
    // tick, and its stamped key is the durable answer. Re-resolving it through
    // the index would be wrong as well as wasteful: if that work item has since
    // retracted this resource, the index no longer holds it, the lookup misses,
    // and a miss means mint — so a re-polled event (sources legitimately
    // re-emit the same eventId, e.g. an unchanged issue) would fork a duplicate
    // work item. Reusing the persisted key keeps resolution idempotent per
    // event id, which is what the append-only log already promises.
    const persisted = await deps.stateStore.readEventEnvelope(unkeyed.eventId);
    if (persisted !== null) {
      // Heal a partially minted work item. The index entry for a resource is
      // written only when its origin wake.correlation.registered event is
      // *folded*, several appends after the founding source event. A crash in
      // that window leaves the source event durable — so this branch suppresses
      // re-minting — while the index has no entry, and a later event on the
      // same resource would miss the index and fork a duplicate work item
      // (crash/restart safety, CLAUDE.md). If the index does not credit this
      // event's work item *and* its origin correlation never landed, re-emit
      // the mint tail (idempotent by id). The guard is the missing origin
      // event, not merely an empty index: a deliberately *retracted* resource
      // also resolves to undefined but keeps its origin-correlation event on
      // record, and must not be silently re-registered.
      const owner = await deps.resourceIndex.resolve(resourceUri);
      if (
        persisted.workItemKey !== UNRESOLVED_WORK_ITEM_KEY &&
        owner === undefined &&
        (await deps.stateStore.readEventEnvelope(
          `${persisted.workItemKey}-origin-correlation`,
        )) === null
      ) {
        return [
          { envelope: persisted, persisted: true },
          ...buildOriginCorrelationEvents(persisted.workItemKey, unkeyed, resourceUri).map(
            (envelope) => ({ envelope, persisted: false }),
          ),
        ];
      }
      return [{ envelope: persisted, persisted: true }];
    }

    const existingWorkItemKey = await deps.resourceIndex.resolve(resourceUri);
    if (existingWorkItemKey !== undefined) {
      return [
        {
          envelope: createEventEnvelope({ ...unkeyed, workItemKey: existingWorkItemKey }),
          persisted: false,
        },
      ];
    }

    // resourceUri itself misses the index (e.g. a review-thread comment's
    // resourceUri is unique per thread, never registered on its own), but the
    // adapter may have named a parent resource this one belongs to. Resolve
    // through that instead of minting — and register this exact resourceUri
    // as a secondary correlation so it's on record on the work item, even
    // though (being secondary) it still won't shortcut future lookups via the
    // index itself (ADR 0001 §5: the index is primary-only).
    if (unkeyed.sourceRefs.parentResourceUri !== undefined) {
      const parentWorkItemKey = await deps.resourceIndex.resolve(
        unkeyed.sourceRefs.parentResourceUri,
      );
      if (parentWorkItemKey !== undefined) {
        const mintedAt = laterTimestamp(unkeyed.ingestedAt, eventStampNow());
        return [
          {
            envelope: createEventEnvelope({ ...unkeyed, workItemKey: parentWorkItemKey }),
            persisted: false,
          },
          {
            envelope: createEventEnvelope({
              eventId: `${parentWorkItemKey}-correlation-${resourceUri.replace(/[^a-z0-9]+/gi, '-')}`,
              workItemKey: parentWorkItemKey,
              streamScope: 'work-item',
              direction: 'internal',
              sourceSystem: 'wake',
              sourceEventType: CORRELATION_REGISTERED_EVENT,
              sourceRefs: unkeyed.sourceRefs,
              occurredAt: mintedAt,
              ingestedAt: mintedAt,
              trigger: 'context-only',
              payload: {
                resourceUri,
                role: 'review',
                relation: 'secondary',
                provenance: 'detected',
              },
            }),
            persisted: false,
          },
        ];
      }
    }

    if (!policy.qualifiesForMint(unkeyed, deps.config)) {
      return [
        {
          envelope: createEventEnvelope({ ...unkeyed, workItemKey: UNRESOLVED_WORK_ITEM_KEY }),
          persisted: false,
        },
      ];
    }

    const workItemKey = createWorkId();
    const keyed = createEventEnvelope({ ...unkeyed, workItemKey });

    return [
      { envelope: keyed, persisted: false },
      ...buildOriginCorrelationEvents(workItemKey, unkeyed, resourceUri).map((envelope) => ({
        envelope,
        persisted: false,
      })),
    ];
  }

  async function ingestInboundEvents(
    unkeyedEvents: UnkeyedEventEnvelope[],
  ): Promise<EventEnvelope[]> {
    const ingested: EventEnvelope[] = [];

    for (const unkeyed of unkeyedEvents) {
      const resolved = await resolveInboundEvent(unkeyed);
      // Fold what was actually persisted, never the in-memory copy:
      // appendEventEnvelope is id-deduplicated and returns the *existing*
      // envelope when one is already on record. Folding our own copy instead
      // would let state/ diverge from events/ — and replay is defined by
      // events/, so the divergence would only surface after a rebuild. An event
      // already flagged `persisted` needs no second append: appendEventEnvelope
      // would only re-read it off disk and hand back the same envelope, and
      // every unchanged issue is re-polled every tick, so that read is the
      // dominant redundant cost this branch avoids.
      const events: EventEnvelope[] = [];
      for (const { envelope, persisted } of resolved) {
        events.push(persisted ? envelope : await deps.stateStore.appendEventEnvelope(envelope));
      }
      // Folded before the next event is resolved, because it is the fold of
      // the registration event that writes the index entry the *next* event on
      // the same resource resolves through. Deferring the fold to the end of
      // the batch would let a second event for the same ticket miss and mint a
      // duplicate work item. Every event in a poll batch shares the source's
      // one ingestedAt, so folding per event preserves exactly the order a
      // single batched fold would have produced.
      await projectionUpdater.rebuildFromEvents(events);
      ingested.push(...events);
    }

    return ingested;
  }

  function runnerTimeoutMs(): number {
    return maxConfiguredRunnerTimeoutMs(deps.config);
  }

  function isPerIssueWorkspacePath(workspacePath: string): boolean {
    const workspacesRoot = join(deps.config.paths.wakeRoot, 'workspaces');
    const rel = relative(workspacesRoot, workspacePath);
    return !rel.startsWith('..') && !isAbsolute(rel) && rel.length > 0;
  }

  async function cleanupClosedIssueWorkspaces(
    projections: import('../domain/types.js').IssueStateRecord[],
  ): Promise<void> {
    for (const projection of projections) {
      const { workspacePath } = projection.wake;
      if (
        projection.issue.state === 'closed' &&
        workspacePath !== undefined &&
        isPerIssueWorkspacePath(workspacePath)
      ) {
        try {
          await deps.workspaceManager.cleanupWorkspace({ workspacePath });
          if (!deps.config.transcripts.retainAfterWorkspaceCleanup) {
            await rm(deps.stateStore.paths.transcriptWorkDir(projection.workItemKey), {
              recursive: true,
              force: true,
            });
          }
        } catch (error) {
          const failedAt = eventStampNow();
          await deps.stateStore.appendEventEnvelope(createEventEnvelope({
            eventId: `workspace-cleanup-failed-${projection.issue.repo.replace(/[^a-z0-9]+/gi, '-')}-${projection.issue.number}`,
            workItemKey: projection.workItemKey,
            streamScope: 'work-item',
            direction: 'internal',
            sourceSystem: 'wake',
            sourceEventType: 'wake.workspace.cleanup-failed',
            sourceRefs: {
              repo: projection.issue.repo,
              issueNumber: projection.issue.number,
            },
            occurredAt: failedAt,
            ingestedAt: failedAt,
            trigger: 'context-only',
            payload: {
              workspacePath,
              error: error instanceof Error ? error.message : String(error),
            },
          }));
          continue;
        }
        const cleanedAt = eventStampNow();
        const cleanupEvent = createEventEnvelope({
          eventId: `workspace-cleaned-${projection.issue.repo.replace(/[^a-z0-9]+/gi, '-')}-${projection.issue.number}-${deps.clock.now().getTime()}`,
          workItemKey: projection.workItemKey,
          streamScope: 'work-item',
          direction: 'internal',
          sourceSystem: 'wake',
          sourceEventType: 'wake.workspace.cleaned',
          sourceRefs: {
            repo: projection.issue.repo,
            issueNumber: projection.issue.number,
          },
          occurredAt: cleanedAt,
          ingestedAt: cleanedAt,
          trigger: 'immediate',
          payload: { workspacePath },
        });
        await deps.stateStore.appendEventEnvelope(cleanupEvent);
        await projectionUpdater.rebuildFromEvents([cleanupEvent]);
      }
    }
  }

  function isStaleRunningRecord(record: RunRecord, now: Date): boolean {
    if (record.status !== 'running') {
      return false;
    }

    const startedAtMs = Date.parse(record.startedAt);
    if (!Number.isFinite(startedAtMs)) {
      return true;
    }

    return now.getTime() - startedAtMs >= runnerTimeoutMs();
  }

  async function reconcileStaleRunningRecords(now: Date): Promise<void> {
    const finishedAt = now.toISOString();
    const runRecords = await deps.stateStore.listRunRecords();
    const staleRecords = runRecords
      .filter((record) => isStaleRunningRecord(record, now));

    for (const record of staleRecords) {
      // Run records carry the work item they belong to, so this is a direct
      // O(1) read — no scan, no index, no source ambiguity. The record's
      // repo/issueNumber are representation content and take no part in it.
      const projection = await deps.stateStore.readIssueState(record.workItemKey);
      const newerCompletedRun = runRecords.some((candidate) =>
        candidate.workItemKey === record.workItemKey &&
        candidate.runId !== record.runId &&
        candidate.status !== 'running' &&
        Date.parse(candidate.startedAt) > Date.parse(record.startedAt)
      );
      // Equivalent to the previous `projection?.wake.lastRunId !== record.runId`,
      // spelled out so the non-null projection is available below for its
      // workItemKey.
      if (projection === null || projection.wake.lastRunId !== record.runId || newerCompletedRun) {
        await deps.stateStore.writeRunRecord({
          ...record,
          status: 'superseded',
          finishedAt,
          summary: 'Stale running record was superseded by a newer run.',
          metadata: {
            ...record.metadata,
            reconciledBy: 'stale-running-record',
            supersededBy: projection?.wake.lastRunId,
          },
        });
        continue;
      }

      await deps.stateStore.writeRunRecord({
        ...record,
        status: 'failed',
        finishedAt,
        sentinel: 'FAILED',
        summary: `Run exceeded timeout while marked running and was reconciled by a later tick.`,
        metadata: {
          ...record.metadata,
          reconciledBy: 'stale-running-record',
          timeoutMs: runnerTimeoutMs(),
        },
      });

      const runCompletedEvent = createEventEnvelope({
        eventId: `${record.runId}-stale-reconciled`,
        workItemKey: projection.workItemKey,
        streamScope: 'work-item',
        direction: 'internal',
        sourceSystem: 'wake',
        sourceEventType: 'wake.run.completed',
        sourceRefs: {
          repo: record.repo,
          issueNumber: record.issueNumber,
          runId: record.runId,
        },
        occurredAt: finishedAt,
        ingestedAt: finishedAt,
        trigger: 'immediate',
        payload: {
          action: record.action,
          sentinel: 'FAILED',
          runId: record.runId,
          reason: 'runner:stale-timeout',
          ...(record.routing === undefined ? {} : { routing: record.routing }),
        },
      });
      await deps.stateStore.appendEventEnvelope(runCompletedEvent);
      await projectionUpdater.rebuildFromEvents([runCompletedEvent]);

      const updatedProjection = await deps.stateStore.readIssueState(projection.workItemKey);
      if (updatedProjection !== null) {
        await deliverOutboundEvent(
          createLabelsEvent({
            projection: updatedProjection,
            runId: record.runId,
            statusLabel: 'wake:status.failed',
            stageLabel: stageLabelForStage(updatedProjection.wake.stage),
            occurredAt: finishedAt,
          }),
        );
      }
    }
  }

  const outboxMaxAttempts = 3;

  async function recordDeliveryFailure(intentEvent: EventEnvelope, err: unknown): Promise<void> {
    const occurredAt = deps.clock.now().toISOString();
    const failureEvent = createEventEnvelope({
      eventId: `${intentEvent.eventId}-delivery-failed-${randomUUID()}`,
      workItemKey: intentEvent.workItemKey,
      streamScope: 'work-item',
      direction: 'internal',
      sourceSystem: 'wake',
      sourceEventType: 'wake.publish.failed',
      sourceRefs: intentEvent.sourceRefs,
      occurredAt,
      ingestedAt: occurredAt,
      trigger: 'context-only',
      payload: {
        intentEventId: intentEvent.eventId,
        intentEventType: intentEvent.sourceEventType,
        error: err instanceof Error ? err.message : String(err),
      },
    });
    await deps.stateStore.appendEventEnvelope(failureEvent);
    await projectionUpdater.rebuildFromEvents([failureEvent]);
  }

  // Outbound delivery (comments, labels) is attempted independently of run-outcome
  // recording: a delivery failure must never rewrite an already-recorded run result
  // (S1), and must always leave a durable, retryable trace instead of being lost
  // (E5). This never throws — failures become a `wake.publish.failed` event.
  async function attemptDelivery(event: EventEnvelope): Promise<void> {
    if (deps.outboundSink === undefined) {
      return;
    }

    try {
      const deliveryEvents = await deps.outboundSink.deliverIntent({ event });
      for (const deliveryEvent of deliveryEvents) {
        await deps.stateStore.appendEventEnvelope(deliveryEvent);
      }
      await projectionUpdater.rebuildFromEvents(deliveryEvents);

      if (deliveryEvents.length === 0) {
        // No confirmation event was produced (e.g. a no-op label update) but the
        // sink did not throw. Record that delivery was attempted successfully so
        // the outbox scan below does not retry it indefinitely.
        const confirmedAt = deps.clock.now().toISOString();
        const confirmedEvent = createEventEnvelope({
          eventId: `${event.eventId}-confirmed`,
          workItemKey: event.workItemKey,
          streamScope: 'work-item',
          direction: 'internal',
          sourceSystem: 'wake',
          sourceEventType: 'wake.publish.confirmed',
          sourceRefs: event.sourceRefs,
          occurredAt: confirmedAt,
          ingestedAt: confirmedAt,
          trigger: 'context-only',
          payload: { intentEventId: event.eventId },
        });
        await deps.stateStore.appendEventEnvelope(confirmedEvent);
      }
    } catch (err) {
      await recordDeliveryFailure(event, err);
    }
  }

  async function deliverOutboundEvent(event: EventEnvelope): Promise<void> {
    await deps.stateStore.appendEventEnvelope(event);
    await projectionUpdater.rebuildFromEvents([event]);
    await attemptDelivery(event);
  }

  const outboundIntentEventTypes = new Set([
    'wake.publish.intent.requested',
    'wake.labels.requested',
  ]);
  const outboundConfirmationEventTypes = new Set([
    'ticket.reply.published',
    'ticket.labels.updated',
    'wake.publish.confirmed',
    'pr.comment.reply.published',
    'pr.review-comment.reply.published',
  ]);

  // Adopts the outbox pattern: an intent is only considered delivered once a
  // matching confirmation event exists. Anything left unconfirmed by a prior tick
  // (e.g. the process crashed mid-delivery) is retried here, bounded so a
  // permanently failing sink dead-letters instead of retrying forever.
  async function retryUnconfirmedDeliveries(): Promise<void> {
    if (deps.outboundSink === undefined) {
      return;
    }

    const events = await deps.stateStore.listEventEnvelopes();
    const confirmedIntentIds = new Set<string>();
    const failureAttempts = new Map<string, number>();

    for (const event of events) {
      const intentEventId = event.payload.intentEventId;
      if (typeof intentEventId !== 'string') {
        continue;
      }
      if (outboundConfirmationEventTypes.has(event.sourceEventType)) {
        confirmedIntentIds.add(intentEventId);
      }
      if (event.sourceEventType === 'wake.publish.failed') {
        failureAttempts.set(intentEventId, (failureAttempts.get(intentEventId) ?? 0) + 1);
      }
    }

    for (const intent of events) {
      if (!outboundIntentEventTypes.has(intent.sourceEventType)) {
        continue;
      }
      if (confirmedIntentIds.has(intent.eventId)) {
        continue;
      }
      if ((failureAttempts.get(intent.eventId) ?? 0) >= outboxMaxAttempts) {
        continue;
      }
      await attemptDelivery(intent);
    }
  }

  return {
    async runTick() {
      const lock = await acquireFileLock(deps.stateStore.paths.tickLockFile, {
        staleAfterMs: runnerTimeoutMs(),
      });
      if (!lock.acquired) {
        return { status: 'locked' as const };
      }

      try {
        // The tick's *decision* clock: one consistent "now" for staleness and
        // policy, so a single tick's decisions can't disagree with themselves.
        // It is deliberately NOT an event-stamping clock — see eventStampNow().
        // Its only remaining uses are the run records' startedAt (run records
        // are not events and take no part in the rebuild fold).
        const tickStartedAt = deps.clock.now();
        const nowIso = tickStartedAt.toISOString();
        await reconcileStaleRunningRecords(tickStartedAt);
        await retryUnconfirmedDeliveries();
        const watchlistProjections = await deps.stateStore.listIssueStates();
        const inboundEvents = await ingestInboundEvents(
          await deps.workSource.pollEvents({ watch: deriveWatchlist(watchlistProjections) }),
        );

        const projections = await deps.stateStore.listIssueStates();
        await cleanupClosedIssueWorkspaces(projections);
        if (inboundEvents.length > 0) {
          await markPendingActionableIssues(projections);
        }

        const candidate = projections.find((issue) => {
          if (!policy.isEligible(issue, deps.config)) {
            return false;
          }

          if (isAwaitingApproval(issue)) {
            return policy.needsWakeAction(issue);
          }

          const nextAction =
            policy.chooseAction(issue.wake.stage) ??
            policy.chooseRetryActionAfterHumanReply(issue);
          return nextAction !== null && policy.needsWakeAction(issue);
        });

        if (candidate === undefined) {
          return { status: 'idle' as const };
        }

        let action: AgentAction;

        if (isAwaitingApproval(candidate)) {
          const approvalResolution = policy.resolveApprovalTransition(candidate);
          if (approvalResolution === null) {
            return { status: 'idle' as const };
          }

          if (approvalResolution.approved) {
            const approvalId = `approval-${candidate.issue.number}-${deps.clock.now().getTime()}`;
            const approvedAt = deps.clock.now().toISOString();
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            const nextStage = lifecycle.nextStageFromSentinel(approvalResolution.pendingAction, 'DONE')!;

            const approvalCompletedEvent = createEventEnvelope({
              eventId: `${approvalId}-completed`,
              workItemKey: candidate.workItemKey,
              streamScope: 'work-item',
              direction: 'internal',
              sourceSystem: 'wake',
              sourceEventType: 'wake.run.completed',
              sourceRefs: {
                repo: candidate.issue.repo,
                issueNumber: candidate.issue.number,
                runId: approvalId,
              },
              occurredAt: approvedAt,
              ingestedAt: approvedAt,
              trigger: 'immediate',
              payload: {
                action: approvalResolution.pendingAction,
                sentinel: 'DONE',
                nextStage,
                runId: approvalId,
                reason: 'human:approved',
                handledCommentId: latestHumanCommentId(candidate),
              },
            });
            await deps.stateStore.appendEventEnvelope(approvalCompletedEvent);
            await projectionUpdater.rebuildFromEvents([approvalCompletedEvent]);

            await deliverOutboundEvent(
              createLabelsEvent({
                projection: candidate,
                runId: approvalId,
                statusLabel: statusLabelForStage(nextStage),
                stageLabel: stageLabelForStage(nextStage),
                occurredAt: approvedAt,
              }),
            );

            return {
              status: 'processed' as const,
              runId: approvalId,
              sentinel: 'DONE' as const,
              nextStage,
            };
          }

          action = approvalResolution.pendingAction;
        } else {
          const nextAction =
            policy.chooseAction(candidate.wake.stage) ??
            policy.chooseRetryActionAfterHumanReply(candidate);
          if (nextAction === null) {
            return { status: 'idle' as const };
          }
          action = nextAction;
        }

        // Resolve routing (with sideways fallback across quota-paused runners,
        // #67) before claiming a run, so a fully-paused tier costs nothing more
        // than an idle tick instead of a claimed-but-doomed run record.
        const ledgerAtStart = await deps.stateStore.readLedger();
        const routing = resolveRunnerRouting({
          config: deps.config,
          stage: candidate.wake.stage,
          action,
          now: tickStartedAt,
          ...(ledgerAtStart === null ? {} : { ledger: ledgerAtStart }),
        });
        if (routing === null) {
          return { status: 'idle' as const };
        }

        const runId = `run-${candidate.issue.number}-${deps.clock.now().getTime()}`;
        const runningRecord = {
          schemaVersion: 1 as const,
          runId,
          workItemKey: candidate.workItemKey,
          repo: candidate.issue.repo,
          issueNumber: candidate.issue.number,
          action,
          status: 'running' as const,
          startedAt: nowIso,
        };

        await deps.stateStore.writeRunRecord(runningRecord);
        const claimedStage = action as import('../domain/types.js').Stage;
        const claimedAt = eventStampNow();
        const claimedEvent = createEventEnvelope({
          eventId: `${runId}-claimed`,
          workItemKey: candidate.workItemKey,
          streamScope: 'work-item',
          direction: 'internal',
          sourceSystem: 'wake',
          sourceEventType: 'wake.run.claimed',
          sourceRefs: {
            repo: candidate.issue.repo,
            issueNumber: candidate.issue.number,
            runId,
          },
          occurredAt: claimedAt,
          ingestedAt: claimedAt,
          trigger: 'immediate',
          payload: {
            action,
            priorStage: candidate.wake.stage,
            claimedStage,
          },
        });
        await deps.stateStore.appendEventEnvelope(claimedEvent);
        await projectionUpdater.rebuildFromEvents([claimedEvent]);

        await deliverOutboundEvent(
          createLabelsEvent({
            projection: candidate,
            runId,
            statusLabel: 'wake:status.working',
            stageLabel: stageLabelForStage(claimedStage),
            occurredAt: eventStampNow(),
          }),
        );

        try {
          // 'implement' gets its own branch/workspace; 'refine' only reads
          // the issue and, at most, the canonical clone read-only - it never
          // pays per-issue workspace-preparation cost.
          const prepareResult =
            action === 'implement'
              ? await deps.workspaceManager.prepareWorkspace({
                  workId: candidate.workItemKey,
                  repo: candidate.issue.repo,
                  issueNumber: candidate.issue.number,
                })
              : await deps.workspaceManager.prepareReadOnlyClone({
                  repo: candidate.issue.repo,
                });

          const { workspacePath } = prepareResult;
          const mergeConflictDetected =
            'mergeConflictDetected' in prepareResult ? prepareResult.mergeConflictDetected : false;
          const upstreamChanges =
            'upstreamChanges' in prepareResult && typeof prepareResult.upstreamChanges === 'string'
              ? prepareResult.upstreamChanges
              : undefined;

          const recentEvents = await deps.stateStore.listEventEnvelopesForWorkItem(
            candidate.workItemKey,
            6,
          );
          const runnerResult = await deps.runner.run({
            action,
            projection: candidate,
            recentEvents,
            config: deps.config,
            runId,
            routing,
            ...(workspacePath === undefined ? {} : { workspacePath }),
            ...(mergeConflictDetected ? { mergeConflictDetected: true } : {}),
            ...(upstreamChanges === undefined ? {} : { upstreamChanges }),
          });
          const parsedRunnerResult = parseRunnerResult(runnerResult.result);
          const rawSentinel = parsedRunnerResult.status;
          // Coerce DONE → AWAITING_APPROVAL when the stage requires human sign-off.
          // An agent that writes DONE but was told not to skip approval has violated
          // the protocol; treat it as AWAITING_APPROVAL so the gate is enforced.
          const skipApproval = runnerResult.metadata?.skipApproval;
          const sentinel =
            rawSentinel === 'DONE' && skipApproval === false
              ? 'AWAITING_APPROVAL'
              : rawSentinel;
          const nextStage = lifecycle.nextStageFromSentinel(action, sentinel);
          const finishedAt = deps.clock.now().toISOString();

          // Only 'implement' has a workspace/branch to verify a reported PR's
          // head against — 'refine' never pushes anything, so there is
          // nothing for a PR claim to have come from.
          if (action === 'implement') {
            await registerReportedArtifacts({
              projection: candidate,
              runId,
              runnerResult,
              branch: branchNameForIssue(candidate.issue.number),
              occurredAt: finishedAt,
            });
          }

          const failedRunnerName = runnerResult.routing?.runnerName ?? routing.runnerName;
          const existingRunners = ledgerAtStart?.runners ?? {};
          if (runnerResult.failureClass === 'quota') {
            const failureCount = (existingRunners[failedRunnerName]?.failureCount ?? 0) + 1;
            const quotaPause = resolveQuotaPauseUntil({
              result: runnerResult.result,
              now: new Date(finishedAt),
              failureCount,
            });
            await deps.stateStore.writeLedger({
              schemaVersion: 1,
              runners: {
                ...existingRunners,
                [failedRunnerName]: {
                  pausedUntil: quotaPause.pausedUntil,
                  pausedUntilSource: quotaPause.source,
                  failureCount,
                  lastFailureAt: finishedAt,
                },
              },
            });
          } else if ((existingRunners[failedRunnerName]?.failureCount ?? 0) > 0) {
            await deps.stateStore.writeLedger({
              schemaVersion: 1,
              runners: {
                ...existingRunners,
                [failedRunnerName]: { failureCount: 0 },
              },
            });
          }
          const resultMetadata = {
            ...runnerResult.metadata,
            envelope: parsedRunnerResult.envelope,
            ...(runnerResult.failureClass === undefined
              ? {}
              : { failureClass: runnerResult.failureClass }),
            ...(runnerResult.routing === undefined ? {} : { routing: runnerResult.routing }),
          };

          await deps.stateStore.writeRunRecord({
            ...runningRecord,
            status:
              sentinel === 'DONE'
                ? 'completed'
                : sentinel === 'BLOCKED'
                  ? 'blocked'
                  : sentinel === 'AWAITING_APPROVAL'
                    ? 'awaiting-approval'
                    : 'failed',
            finishedAt,
            sessionId: runnerResult.session_id,
            sentinel,
            summary: parsedRunnerResult.body,
            ...(runnerResult.routing === undefined ? {} : { routing: runnerResult.routing }),
            ...(runnerResult.tokenUsage === undefined ? {} : { tokenUsage: runnerResult.tokenUsage }),
            metadata: resultMetadata,
          });

          const runCompletedEvent = createEventEnvelope({
            eventId: `${runId}-completed`,
            workItemKey: candidate.workItemKey,
            streamScope: 'work-item',
            direction: 'internal',
            sourceSystem: 'wake',
            sourceEventType: 'wake.run.completed',
            sourceRefs: {
              repo: candidate.issue.repo,
              issueNumber: candidate.issue.number,
              runId,
            },
            occurredAt: finishedAt,
            ingestedAt: finishedAt,
            trigger: 'immediate',
            payload: {
              action,
              sentinel,
              ...(rawSentinel !== sentinel ? { rawSentinel } : {}),
              ...(nextStage !== null ? { nextStage } : {}),
              runId,
              sessionId: runnerResult.session_id,
              sessionCli: runnerResult.cli,
              workspacePath,
              reason: `runner:${sentinel.toLowerCase()}`,
              ...(runnerResult.routing === undefined ? {} : { routing: runnerResult.routing }),
              ...(runnerResult.failureClass === undefined
                ? {}
                : { failureClass: runnerResult.failureClass }),
              // Only mark the triggering comment handled when the run reached the
              // agent and produced a real outcome. Quota/infra failures are transient
              // blips, not an answer to the human's comment — leaving handledCommentId
              // unset lets the next tick retry instead of silently eating the request (S9).
              ...(runnerResult.failureClass === 'quota' || runnerResult.failureClass === 'infra'
                ? {}
                : { handledCommentId: latestHumanCommentId(candidate) }),
              body: parsedRunnerResult.body,
              envelope: parsedRunnerResult.envelope,
            },
          });
          await deps.stateStore.appendEventEnvelope(runCompletedEvent);
          await projectionUpdater.rebuildFromEvents([runCompletedEvent]);

          await deliverOutboundEvent(
            createLabelsEvent({
              projection: candidate,
              runId,
              statusLabel: statusLabelForOutcome({
                sentinel,
                stage: nextStage ?? claimedStage,
              }),
              stageLabel: stageLabelForStage(nextStage ?? claimedStage),
              occurredAt: finishedAt,
            }),
          );

          if (runnerResult.failureClass !== 'quota') {
            const publishIntent = createPublishIntentEvent({
              projection: candidate,
              runId,
              action,
              runnerResult,
              parsedRunnerResult,
              sentinel,
              occurredAt: finishedAt,
              startedAt: nowIso,
              ...(workspacePath === undefined ? {} : { workspacePath }),
            });

            await deliverOutboundEvent(publishIntent);
          }

          return {
            status: 'processed' as const,
            runId,
            sentinel,
            nextStage,
          };
        } catch (err) {
          const finishedAt = deps.clock.now().toISOString();
          const sentinel = 'FAILED' as const;

          await deps.stateStore.writeRunRecord({
            ...runningRecord,
            status: 'failed',
            finishedAt,
            sentinel,
            summary: err instanceof Error ? err.message : String(err),
            metadata: {
              failureClass: 'infra',
            },
          });

          const runCompletedEvent = createEventEnvelope({
            eventId: `${runId}-completed`,
            workItemKey: candidate.workItemKey,
            streamScope: 'work-item',
            direction: 'internal',
            sourceSystem: 'wake',
            sourceEventType: 'wake.run.completed',
            sourceRefs: {
              repo: candidate.issue.repo,
              issueNumber: candidate.issue.number,
              runId,
            },
            occurredAt: finishedAt,
            ingestedAt: finishedAt,
            trigger: 'immediate',
            payload: {
              action,
              sentinel,
              runId,
              reason: 'runner:infrastructure-error',
              failureClass: 'infra',
              // Deliberately omit handledCommentId: an infra blip (CLI crash, timeout,
              // network error) never reached the agent, so it isn't an answer to the
              // triggering comment. Leaving it unset lets the next tick retry the same
              // request instead of silently eating it (S9).
            },
          });
          await deps.stateStore.appendEventEnvelope(runCompletedEvent);
          await projectionUpdater.rebuildFromEvents([runCompletedEvent]);

          await deliverOutboundEvent(
            createLabelsEvent({
              projection: candidate,
              runId,
              statusLabel: 'wake:status.failed',
              stageLabel: stageLabelForStage(claimedStage),
              occurredAt: finishedAt,
            }),
          );

          const errorMessage = err instanceof Error ? err.message : String(err);
          const infraFailureResult: import('./contracts.js').AgentRunResult = {
            result: errorMessage,
            model: 'unknown',
            cli: 'unknown',
          };
          const parsedInfraFailureResult = parseRunnerResult(infraFailureResult.result);
          const failurePublishIntent = createPublishIntentEvent({
            projection: candidate,
            runId,
            action,
            runnerResult: infraFailureResult,
            parsedRunnerResult: parsedInfraFailureResult,
            sentinel,
            occurredAt: finishedAt,
            startedAt: nowIso,
          });
          await deliverOutboundEvent(failurePublishIntent);

          return {
            status: 'processed' as const,
            runId,
            sentinel,
            nextStage: null,
          };
        }
      } finally {
        await lock.release();
      }
    },
  };
}
