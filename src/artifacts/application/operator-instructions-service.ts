import {
  EventActorKind,
  EventSourceKind,
  WrongExpectedSequenceError,
  type CommandContext,
  type EventJournal,
  type ProjectionStore,
} from '@atolis-hq/eventing';
import type { ArtifactsConfig } from '../contracts/config.js';
import { createArtifactContextEventData } from '../contracts/context-event-factory.js';
import {
  ArtifactContextEventType,
  selectArtifactContextEvent,
} from '../contracts/context-events.js';
import {
  artifactSharedContextNameSchema,
  type OperatorInstructionsDocument,
  type OperatorInstructionsListing,
  type OperatorInstructionsRevision,
} from '../contracts/context.js';
import { artifactContextStream } from '../contracts/streams.js';
import type { FileArtifactStore } from '../infrastructure/file-artifact-store.js';
import { operatorInstructionsProjection } from './operator-instructions-projection.js';

export class OperatorInstructionsConflict extends Error {}

/** Trusted host write path. No MCP operation receives this service. */
export class OperatorInstructionsService {
  constructor(
    private readonly journal: EventJournal,
    private readonly store: FileArtifactStore,
    private readonly config: ArtifactsConfig,
  ) {}

  async list(
    projections: ProjectionStore,
    excludedScopes: ReadonlySet<string> = new Set(),
  ): Promise<readonly OperatorInstructionsListing[]> {
    const revisions = (
      await projections.list<OperatorInstructionsRevision | null>(
        operatorInstructionsProjection.name,
      )
    )
      .flatMap((entry) =>
        entry.value === null || excludedScopes.has(entry.key) ? [] : [entry.value],
      )
      .sort((a, b) => a.contextScope.localeCompare(b.contextScope));
    return Promise.all(
      revisions.map(async (revision) => {
        try {
          return await this.document(revision);
        } catch {
          return { ...revision, content: null };
        }
      }),
    );
  }

  async current(contextScope: string): Promise<OperatorInstructionsDocument | null> {
    const revisions = await this.revisions(contextScope);
    const revision = revisions.at(-1);
    return revision === undefined ? null : this.document(revision);
  }

  async read(
    contextScope: string,
    revisionId: string,
  ): Promise<OperatorInstructionsDocument | null> {
    const revision = (await this.revisions(contextScope)).find(
      (item) => item.revisionId === revisionId,
    );
    return revision === undefined ? null : this.document(revision);
  }

  async save(
    input: {
      readonly contextScope: string;
      readonly revisionId: string;
      readonly expectedRevisionId: string | null;
      readonly content: string;
    },
    context: CommandContext,
  ): Promise<OperatorInstructionsDocument> {
    artifactSharedContextNameSchema.parse(input.contextScope);
    if (context.actor.kind !== EventActorKind.Operator)
      throw new Error('Operator instructions require a trusted operator command');
    const bytes = new TextEncoder().encode(input.content);
    if (bytes.byteLength > this.config.maxWriteBytes)
      throw new Error(`Operator instructions exceed ${this.config.maxWriteBytes} byte limit`);
    const stream = artifactContextStream(input.contextScope);
    const events = await this.journal.readStream(stream);
    const revisions = this.selectRevisions(events);
    const existing = revisions.find((item) => item.revisionId === input.revisionId);
    if (existing !== undefined) {
      const document = await this.document(existing);
      if (document.content !== input.content || document.author !== context.actor.id)
        throw new OperatorInstructionsConflict(
          'Instructions command was already used for another edit',
        );
      return document;
    }
    if ((revisions.at(-1)?.revisionId ?? null) !== input.expectedRevisionId)
      throw new OperatorInstructionsConflict(
        'Instructions changed. Reload before saving; your draft has been preserved.',
      );
    const stored = await this.store.writeOperatorInstructions({ ...input, bytes });
    const revision: OperatorInstructionsRevision = {
      contextScope: input.contextScope,
      revisionId: input.revisionId,
      ...stored,
      author: context.actor.id,
      occurredAt: context.occurredAt,
    };
    try {
      await this.journal.appendToStream(stream, events.length, [
        createArtifactContextEventData({
          eventId: `${input.contextScope}:instructions:${input.revisionId}`,
          eventType: ArtifactContextEventType.InstructionsEdited,
          payload: { ...revision, expectedRevisionId: input.expectedRevisionId },
          occurredAt: context.occurredAt,
          actor: context.actor,
          correlationId: context.correlationId,
          causationId: context.commandId,
          source: { kind: EventSourceKind.Internal, id: 'operator-instructions-service' },
        }),
      ]);
    } catch (error) {
      if (error instanceof WrongExpectedSequenceError)
        throw new OperatorInstructionsConflict(
          'Context changed. Reload before saving; your draft has been preserved.',
        );
      throw error;
    }
    return { ...revision, content: input.content };
  }

  private async revisions(contextScope: string) {
    artifactSharedContextNameSchema.parse(contextScope);
    return this.selectRevisions(await this.journal.readStream(artifactContextStream(contextScope)));
  }

  private selectRevisions(
    events: Awaited<ReturnType<EventJournal['readStream']>>,
  ): OperatorInstructionsRevision[] {
    return events.flatMap((envelope) => {
      const event = selectArtifactContextEvent(envelope);
      if (event?.event.eventType !== ArtifactContextEventType.InstructionsEdited) return [];
      if (event.event.actor.kind !== EventActorKind.Operator)
        throw new Error('Invalid operator instructions provenance');
      const { expectedRevisionId: _expected, ...revision } = event.event.payload;
      return [revision];
    });
  }

  private async document(
    revision: OperatorInstructionsRevision,
  ): Promise<OperatorInstructionsDocument> {
    return {
      ...revision,
      content: new TextDecoder('utf-8', { fatal: true }).decode(
        await this.store.read(revision.location),
      ),
    };
  }
}
