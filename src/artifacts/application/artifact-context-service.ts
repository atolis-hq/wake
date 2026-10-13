import { EventSourceKind, type CommandContext, type EventJournal } from '@atolis-hq/eventing';
import type { WorkItemId } from '../../work/index.js';
import {
  createArtifactContextEventData,
  type ArtifactContextEventInput,
} from '../contracts/context-event-factory.js';
import {
  ArtifactContextEventType,
  selectArtifactContextEvent,
  type ArtifactContextEvent,
} from '../contracts/context-events.js';
import {
  artifactContextNameSchema,
  ArtifactMemoryPublicationReason,
  artifactSharedContextNameSchema,
  type ArtifactContextProvenance,
  type ArtifactContextPublication,
  type ArtifactContextView,
  type ArtifactDelegationGrant,
  type ArtifactRevisionReference,
} from '../contracts/context.js';
import { artifactContextStream } from '../contracts/streams.js';
import type { ArtifactService } from './artifact-service.js';

export type ArtifactAcceptance = (activationId: string, workItemId?: string) => Promise<boolean>;

/** Trusted host commands only. MCP never receives enrollment/publication methods. */
export class ArtifactContextService {
  constructor(
    private readonly journal: EventJournal,
    private readonly artifacts: ArtifactService,
  ) {}

  async get(contextScope: string): Promise<ArtifactContextView> {
    return foldContext(contextScope, await this.events(contextScope));
  }

  async enroll(
    contextScope: string,
    workItemId: WorkItemId,
    provenance: ArtifactContextProvenance,
    context: CommandContext,
  ): Promise<void> {
    artifactSharedContextNameSchema.parse(contextScope);
    const events = await this.events(contextScope);
    const view = foldContext(contextScope, events);
    const member = view.members.find((candidate) => candidate.workItemId === workItemId);
    if (member !== undefined) {
      if (JSON.stringify(member.provenance) !== JSON.stringify(provenance))
        throw new Error('Artifact enrollment provenance conflict');
      return;
    }
    await this.append(
      events.length,
      {
        eventType: ArtifactContextEventType.Enrolled,
        payload: { contextScope, workItemId, provenance, expectedMemory: view.memory },
      },
      context,
      `enroll:${workItemId}`,
    );
  }

  async references(
    contextScope: string,
    workItemId: WorkItemId,
  ): Promise<readonly ArtifactRevisionReference[]> {
    const view = await this.get(contextScope);
    if (!view.members.some((member) => member.workItemId === workItemId))
      throw new Error('Work item is not enrolled in artifact context');
    return uniqueReferences(view.publications.flatMap((publication) => publication.references));
  }

  /** One context-stream append records exports, memory CAS and reconciliation receipt. */
  async publish(
    input: {
      readonly contextScope: string;
      readonly workItemId: WorkItemId;
      readonly publicationId: string;
      readonly successful: boolean;
      readonly exports: readonly ArtifactRevisionReference[];
      readonly expectedMemory: ArtifactRevisionReference | null;
    },
    accepted: ArtifactAcceptance,
    context: CommandContext,
  ): Promise<ArtifactContextPublication> {
    artifactSharedContextNameSchema.parse(input.contextScope);
    const events = await this.events(input.contextScope);
    const view = foldContext(input.contextScope, events);
    const receipt = view.publications.find(
      (publication) => publication.publicationId === input.publicationId,
    );
    if (receipt !== undefined) {
      if (receipt.workItemId !== input.workItemId)
        throw new Error('Artifact publication ownership conflict');
      return receipt;
    }
    if (!view.members.some((member) => member.workItemId === input.workItemId))
      throw new Error('Work item is not enrolled in artifact context');
    for (const reference of input.exports) {
      if (reference.workItemId !== input.workItemId)
        throw new Error('Cannot publish another work item artifact');
      await this.requireAccepted(reference, accepted);
    }
    const memories = (
      await this.artifacts.latestPublished(input.workItemId, (id) => accepted(id, input.workItemId))
    ).filter((revision) => revision.path === 'memory.md');
    let reason = memoryReason(input.successful, memories.length);
    let memory =
      reason === ArtifactMemoryPublicationReason.Advanced
        ? { workItemId: input.workItemId, revisionId: memories[0]!.revisionId }
        : null;
    if (memory !== null && !sameReference(view.memory, input.expectedMemory)) {
      reason = ArtifactMemoryPublicationReason.Conflict;
      memory = null;
    }
    const publication: ArtifactContextPublication = {
      publicationId: input.publicationId,
      workItemId: input.workItemId,
      references: uniqueReferences([...input.exports, ...(memory === null ? [] : [memory])]),
      memory,
      reason,
    };
    await this.append(
      events.length,
      {
        eventType: ArtifactContextEventType.Published,
        payload: { contextScope: input.contextScope, ...publication },
      },
      context,
      `publish:${input.publicationId}`,
    );
    return publication;
  }

  async registerChild(
    grant: ArtifactDelegationGrant,
    accepted: ArtifactAcceptance,
    context: CommandContext,
  ): Promise<void> {
    const contextScope = delegationScope(grant.parentWorkItemId);
    const events = await this.events(contextScope);
    const existing = events.find(
      (event) =>
        event.event.eventType === ArtifactContextEventType.Delegated &&
        event.event.payload.delegationId === grant.delegationId,
    );
    if (existing !== undefined) {
      if (JSON.stringify(existing.event.payload) !== JSON.stringify({ contextScope, ...grant }))
        throw new Error('Artifact delegation conflict');
      return;
    }
    if (grant.parentWorkItemId === grant.childWorkItemId)
      throw new Error('Artifact delegation requires distinct work items');
    for (const reference of grant.childReferences) await this.requireAccepted(reference, accepted);
    await this.append(
      events.length,
      { eventType: ArtifactContextEventType.Delegated, payload: { contextScope, ...grant } },
      context,
      `delegate:${grant.delegationId}`,
    );
  }

  async childReferences(
    parentWorkItemId: WorkItemId,
    childWorkItemId: WorkItemId,
  ): Promise<readonly ArtifactRevisionReference[]> {
    return uniqueReferences(
      (await this.delegations(parentWorkItemId))
        .filter((grant) => grant.childWorkItemId === childWorkItemId)
        .flatMap((grant) => grant.childReferences),
    );
  }

  async parentReferences(
    parentWorkItemId: WorkItemId,
    accepted: ArtifactAcceptance,
  ): Promise<readonly ArtifactRevisionReference[]> {
    const references: ArtifactRevisionReference[] = [];
    for (const grant of await this.delegations(parentWorkItemId)) {
      const revisions = await this.artifacts.latestPublished(grant.childWorkItemId, (id) =>
        accepted(id, grant.childWorkItemId),
      );
      references.push(
        ...revisions.map((revision) => ({
          workItemId: grant.childWorkItemId,
          revisionId: revision.revisionId,
        })),
      );
    }
    return uniqueReferences(references);
  }

  private async requireAccepted(
    reference: ArtifactRevisionReference,
    accepted: ArtifactAcceptance,
  ): Promise<void> {
    const revision = (await this.artifacts.get(reference.workItemId))?.revisions.find(
      (candidate) => candidate.revisionId === reference.revisionId,
    );
    if (
      revision === undefined ||
      revision.deleted ||
      !(await accepted(revision.activationId, reference.workItemId))
    )
      throw new Error('Artifact reference is not an accepted revision');
  }

  private async delegations(
    parentWorkItemId: WorkItemId,
  ): Promise<readonly ArtifactDelegationGrant[]> {
    return (await this.events(delegationScope(parentWorkItemId))).flatMap((event) =>
      event.event.eventType === ArtifactContextEventType.Delegated ? [event.event.payload] : [],
    );
  }

  private async events(contextScope: string): Promise<readonly ArtifactContextEvent[]> {
    artifactContextNameSchema.parse(contextScope);
    return (await this.journal.readStream(artifactContextStream(contextScope))).flatMap((event) => {
      const owned = selectArtifactContextEvent(event);
      return owned === null ? [] : [owned];
    });
  }

  private async append(
    sequence: number,
    input: Pick<ArtifactContextEventInput, 'eventType' | 'payload'>,
    context: CommandContext,
    id: string,
  ): Promise<void> {
    const data = createArtifactContextEventData({
      ...input,
      eventId: `${input.payload.contextScope}:${id}`,
      occurredAt: context.occurredAt,
      correlationId: context.correlationId,
      causationId: context.commandId,
      actor: context.actor,
      source: { kind: EventSourceKind.Internal, id: 'artifact-context-service' },
    } as ArtifactContextEventInput);
    await this.journal.appendToStream(artifactContextStream(input.payload.contextScope), sequence, [
      data,
    ]);
  }
}

function foldContext(
  contextScope: string,
  events: readonly ArtifactContextEvent[],
): ArtifactContextView {
  let view: ArtifactContextView = { contextScope, members: [], publications: [], memory: null };
  for (const event of events) {
    switch (event.event.eventType) {
      case ArtifactContextEventType.Enrolled: {
        const { contextScope: _scope, ...member } = event.event.payload;
        view = { ...view, members: [...view.members, member] };
        break;
      }
      case ArtifactContextEventType.Published: {
        const { contextScope: _scope, ...publication } = event.event.payload;
        view = {
          ...view,
          publications: [...view.publications, publication],
          memory: publication.memory ?? view.memory,
        };
        break;
      }
      case ArtifactContextEventType.Delegated:
        break;
    }
  }
  return view;
}

function memoryReason(successful: boolean, memoryCount: number): ArtifactMemoryPublicationReason {
  if (!successful) return ArtifactMemoryPublicationReason.Failed;
  if (memoryCount === 0) return ArtifactMemoryPublicationReason.Missing;
  return memoryCount > 1
    ? ArtifactMemoryPublicationReason.Ambiguous
    : ArtifactMemoryPublicationReason.Advanced;
}

function uniqueReferences(
  references: readonly ArtifactRevisionReference[],
): readonly ArtifactRevisionReference[] {
  return [
    ...new Map(
      references.map((reference) => [`${reference.workItemId}:${reference.revisionId}`, reference]),
    ).values(),
  ];
}

function sameReference(
  left: ArtifactRevisionReference | null,
  right: ArtifactRevisionReference | null,
): boolean {
  return left === null
    ? right === null
    : right !== null &&
        left.workItemId === right.workItemId &&
        left.revisionId === right.revisionId;
}

function delegationScope(parentWorkItemId: WorkItemId): string {
  return `delegation:${parentWorkItemId}`;
}
