import { reportedArtifactSchema } from '../../activities/index.js';
import {
  createEventDraft,
  EventActorKind,
  EventSourceKind,
  type CheckpointStore,
  type EventEnvelope,
  type EventJournal,
  type IdGenerator,
} from '../../kernel/index.js';
import {
  OrchestrationEventType,
  selectWorkflowOrchestrationEvent,
  workflowInstanceStream,
  type WorkflowInstanceId,
} from '../../orchestration/index.js';
import { cachedJournalView, type CachedJournalView } from '../../persistence/index.js';
import {
  ResourceCorrelationProvenance,
  ResourceCorrelationRole,
  resourceId,
  resourceKind,
  ResourceStreamKind,
  type ResourceKind,
  type ResourceService,
} from '../../resources/index.js';
import {
  ArtifactEventType,
  decodeArtifactEvent,
  type ArtifactEvent,
} from '../contracts/artifact-events.js';
import {
  ArtifactVerificationResult,
  ArtifactVerificationStatus,
  type ArtifactVerificationResult as VerificationResult,
} from '../contracts/artifact-vocabulary.js';
import type { ProviderInstance } from '../contracts/provider.js';
import { integrationStream } from '../contracts/streams.js';

interface ArtifactRegistrationDependencies {
  readonly journal: EventJournal;
  readonly checkpoints: CheckpointStore;
  readonly resources: ResourceService;
  readonly ids: IdGenerator;
  readonly providers: readonly ProviderInstance[];
  readonly maxAmbiguityReconciliationAttempts?: number;
  readonly runs: {
    list(
      activationId?: string,
    ): Promise<readonly { readonly workspace?: { readonly branch?: string | undefined } }[]>;
  };
}

type ArtifactClaim = {
  readonly kind: ResourceKind;
  readonly externalKey: { readonly adapter: string; readonly key: string };
};

type ArtifactRecord = {
  readonly workflowInstanceId: WorkflowInstanceId;
  readonly activationId: string;
  readonly artifact: ArtifactClaim;
  readonly correlationId: string;
  readonly causationId: string;
  readonly occurredAt: string;
};

export class ArtifactRegistrationReactor {
  private readonly latestUnresolved: CachedJournalView<ReadonlyMap<string, ArtifactEvent>>;

  constructor(private readonly dependencies: ArtifactRegistrationDependencies) {
    this.latestUnresolved = cachedJournalView(dependencies.journal, deriveLatestUnresolved);
  }

  async runOnce(limit = 100): Promise<number> {
    const consumer = 'reactor:artifact-registration';
    const events = await this.dependencies.journal.readAll(
      await this.dependencies.checkpoints.load(consumer),
      limit,
    );
    for (const event of events) {
      const outcome = selectWorkflowOrchestrationEvent(event);
      if (outcome?.eventType === OrchestrationEventType.ActivityOutcomeAccepted)
        await this.register(outcome);
      await this.dependencies.checkpoints.save(consumer, event.globalPosition);
    }
    await this.reconcileAmbiguous();
    return events.length;
  }

  private async register(
    outcome: Extract<
      ReturnType<typeof selectWorkflowOrchestrationEvent>,
      { readonly eventType: typeof OrchestrationEventType.ActivityOutcomeAccepted }
    >,
  ): Promise<void> {
    const artifacts = reportedArtifacts(outcome.payload.outcome.data);
    if (artifacts.length === 0) return;
    const branch = await this.branchFor(outcome.payload.activationId);
    if (branch === undefined) return;
    const workItemId = await this.workItemFor(outcome.stream.id);
    if (workItemId === null) return;
    for (const artifact of artifacts)
      await this.verifyAndRegister(
        {
          workflowInstanceId: outcome.stream.id,
          activationId: outcome.payload.activationId,
          artifact,
          correlationId: outcome.correlationId,
          causationId: outcome.eventId,
          occurredAt: outcome.recordedAt,
        },
        branch,
        workItemId as never,
        1,
      );
  }

  private async reconcileAmbiguous(): Promise<void> {
    const latest = await this.latestUnresolved.get();
    for (const event of latest.values()) {
      if (event.payload.status !== ArtifactVerificationStatus.Ambiguous || event.payload.escalated)
        continue;
      const branch = await this.branchFor(event.payload.activationId);
      const workItemId = await this.workItemFor(event.payload.workflowInstanceId);
      if (branch === undefined || workItemId === null) continue;
      await this.verifyAndRegister(
        {
          workflowInstanceId: event.payload.workflowInstanceId,
          activationId: event.payload.activationId,
          artifact: event.payload.artifact,
          correlationId: event.correlationId,
          causationId: event.causationId,
          occurredAt: event.recordedAt,
        },
        branch,
        workItemId as never,
        event.payload.attempt + 1,
      );
    }
  }

  private async verifyAndRegister(
    record: ArtifactRecord,
    branch: string,
    workItemId: string,
    attempt: number,
  ): Promise<void> {
    const provider = this.dependencies.providers.find(
      (candidate) => candidate.adapter === record.artifact.externalKey.adapter,
    );
    if (provider === undefined) return;
    const verified = await provider.verifyArtifact(
      record.artifact.kind,
      record.artifact.externalKey,
      {
        workspaceBranch: branch,
      },
    );
    if (typeof verified === 'string') {
      await this.recordUnresolved(provider, record, verified, attempt);
      return;
    }
    await this.registerVerified(record, verified, workItemId);
  }

  private async registerVerified(
    record: ArtifactRecord,
    verified: Exclude<Awaited<ReturnType<ProviderInstance['verifyArtifact']>>, string>,
    workItemId: string,
  ): Promise<void> {
    const existing = await this.dependencies.resources.findByExternalKey(verified.externalKey);
    const resource =
      existing ??
      (await this.dependencies.resources.discover(
        {
          resourceId: resourceId(this.dependencies.ids.next(ResourceStreamKind.Resource)),
          kind: verified.kind,
          externalKey: verified.externalKey,
          capabilities: verified.capabilities,
          ...(verified.revision === undefined ? {} : { revision: verified.revision }),
        },
        context(record.causationId, record.correlationId, record.occurredAt),
      ));
    try {
      await this.dependencies.resources.correlate(
        resource.resourceId,
        workItemId as never,
        ResourceCorrelationRole.Primary,
        context(record.causationId, record.correlationId, record.occurredAt),
        ResourceCorrelationProvenance.AgentReported,
      );
    } catch {
      // Resources records primary conflicts durably; this flow never guesses a secondary relation.
    }
  }

  private async recordUnresolved(
    provider: ProviderInstance,
    record: ArtifactRecord,
    result: VerificationResult,
    attempt: number,
  ): Promise<void> {
    const stream = integrationStream(provider.adapter);
    const sequence = (await this.dependencies.journal.readStream(stream)).length;
    const ambiguous = result === ArtifactVerificationResult.Ambiguous;
    const escalated =
      ambiguous && attempt >= (this.dependencies.maxAmbiguityReconciliationAttempts ?? 3);
    await this.dependencies.journal.append(stream, sequence, [
      createEventDraft({
        eventId: `${record.causationId}:artifact:${record.artifact.externalKey.key}:unresolved:${attempt}`,
        eventType: ArtifactEventType.VerificationUnresolved,
        occurredAt: record.occurredAt,
        correlationId: record.correlationId as never,
        causationId: record.causationId as never,
        actor: { kind: EventActorKind.Integration, id: 'artifact-registration' },
        source: { kind: EventSourceKind.Internal, id: 'artifact-registration' },
        stream,
        payload: {
          workflowInstanceId: record.workflowInstanceId,
          activationId: record.activationId as never,
          artifact: record.artifact as never,
          status: ambiguous
            ? ArtifactVerificationStatus.Ambiguous
            : ArtifactVerificationStatus.Failed,
          attempt,
          escalated,
        },
      }),
    ]);
  }

  private async branchFor(activationId: string) {
    return (await this.dependencies.runs.list(activationId)).at(-1)?.workspace?.branch;
  }

  private async workItemFor(workflow: WorkflowInstanceId) {
    const events = await this.dependencies.journal.readStream(workflowInstanceStream(workflow));
    const started = events
      .map(selectWorkflowOrchestrationEvent)
      .find((event) => event?.eventType === OrchestrationEventType.InstanceStarted);
    return started?.payload.workItemId ?? null;
  }
}

function deriveLatestUnresolved(
  events: readonly EventEnvelope[],
): ReadonlyMap<string, ArtifactEvent> {
  const latest = new Map<string, ArtifactEvent>();
  for (const event of events) {
    if (event.eventType !== ArtifactEventType.VerificationUnresolved) continue;
    const decoded = decodeArtifactEvent(event);
    const key = `${decoded.causationId}:${decoded.payload.artifact.externalKey.adapter}:${decoded.payload.artifact.externalKey.key}`;
    latest.set(key, decoded);
  }
  return latest;
}

function reportedArtifacts(value: unknown): readonly ArtifactClaim[] {
  if (typeof value !== 'object' || value === null || !('reportedArtifacts' in value)) return [];
  const artifacts = value.reportedArtifacts;
  if (!Array.isArray(artifacts)) return [];
  return artifacts
    .map((artifact) => reportedArtifactSchema.safeParse(artifact))
    .flatMap((result) =>
      result.success
        ? [{ kind: resourceKind(result.data.kind), externalKey: result.data.externalKey }]
        : [],
    );
}

function context(commandId: string, correlationId: string, occurredAt: string) {
  return {
    commandId: `${commandId}:artifact-registration`,
    correlationId: correlationId as never,
    occurredAt,
    actor: { kind: EventActorKind.Integration, id: 'artifact-registration' },
  };
}
