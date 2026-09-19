import { EventSourceKind, type CommandContext } from '@atolis-hq/eventing';
import type { WorkItemId } from '../../work/index.js';
import type { ArtifactsConfig } from '../contracts/config.js';
import { createArtifactEventData } from '../contracts/event-factory.js';
import { ArtifactEventType } from '../contracts/events.js';
import { artifactWorkItemIdForWorkItem } from '../contracts/identifiers.js';
import { artifactPath, type ArtifactPath } from '../contracts/paths.js';
import type { ArtifactWorkItemView } from '../contracts/views.js';
import { FileArtifactStore } from '../infrastructure/file-artifact-store.js';
import { ArtifactRepository } from './artifact-repository.js';

export interface ArtifactService {
  stageRevision(
    command: StageArtifactRevision,
    context: CommandContext,
  ): Promise<ArtifactWorkItemView>;
  stageTombstone(
    command: StageArtifactTombstone,
    context: CommandContext,
  ): Promise<ArtifactWorkItemView>;
  get(workItemId: string): Promise<ArtifactWorkItemView | null>;
  read(location: string): Promise<Uint8Array>;
}

export interface StageArtifactRevision {
  readonly workItemId: WorkItemId;
  readonly revisionId: string;
  readonly producer: string;
  readonly path: ArtifactPath | string;
  readonly runId: string;
  readonly activationId: string;
  readonly bytes: Uint8Array;
  readonly mediaType?: string;
}

export interface StageArtifactTombstone {
  readonly workItemId: WorkItemId;
  readonly revisionId: string;
  readonly producer: string;
  readonly path: ArtifactPath | string;
  readonly runId: string;
  readonly activationId: string;
}

export function createArtifactService(
  journal: ConstructorParameters<typeof ArtifactRepository>[0],
  store: FileArtifactStore,
  config: ArtifactsConfig,
): ArtifactService {
  const repository = new ArtifactRepository(journal);
  return {
    async stageRevision(command, context) {
      if (command.bytes.byteLength > config.maxWriteBytes)
        throw new Error(`Artifact write exceeds ${config.maxWriteBytes} byte limit`);
      const id = artifactWorkItemIdForWorkItem(command.workItemId as never);
      const loaded = await repository.load(id);
      const retained =
        loaded.view?.revisions.reduce((total, revision) => total + (revision.byteLength ?? 0), 0) ??
        0;
      if (retained + command.bytes.byteLength > config.maxWorkItemBytes)
        throw new Error(`Artifact work item exceeds ${config.maxWorkItemBytes} byte limit`);
      if (loaded.view?.revisions.some((revision) => revision.revisionId === command.revisionId))
        return loaded.view;
      const path = artifactPath(String(command.path));
      const stored = await store.write({
        workItemId: command.workItemId,
        revisionId: command.revisionId,
        path,
        bytes: command.bytes,
      });
      const [event] = await repository.append(id, loaded.sequence, [
        createArtifactEventData({
          eventId: `${context.commandId}:${ArtifactEventType.RevisionStaged}:${command.revisionId}`,
          eventType: ArtifactEventType.RevisionStaged,
          occurredAt: context.occurredAt,
          correlationId: context.correlationId,
          causationId: context.commandId,
          actor: context.actor,
          source: { kind: EventSourceKind.Internal, id: 'artifact-service' },
          payload: {
            workItemId: command.workItemId,
            revisionId: command.revisionId,
            producer: command.producer,
            path,
            runId: command.runId,
            activationId: command.activationId,
            ...stored,
            ...(command.mediaType === undefined ? {} : { mediaType: command.mediaType }),
          },
        }),
      ]);
      const view = event === undefined ? null : (await repository.load(id)).view;
      if (view === null)
        throw new Error(`Artifact work item ${command.workItemId} was not created`);
      return view;
    },
    async stageTombstone(command, context) {
      const id = artifactWorkItemIdForWorkItem(command.workItemId as never);
      const loaded = await repository.load(id);
      if (loaded.view?.revisions.some((revision) => revision.revisionId === command.revisionId))
        return loaded.view;
      const [event] = await repository.append(id, loaded.sequence, [
        createArtifactEventData({
          eventId: `${context.commandId}:${ArtifactEventType.TombstoneStaged}:${command.revisionId}`,
          eventType: ArtifactEventType.TombstoneStaged,
          occurredAt: context.occurredAt,
          correlationId: context.correlationId,
          causationId: context.commandId,
          actor: context.actor,
          source: { kind: EventSourceKind.Internal, id: 'artifact-service' },
          payload: {
            workItemId: command.workItemId,
            revisionId: command.revisionId,
            producer: command.producer,
            path: artifactPath(String(command.path)),
            runId: command.runId,
            activationId: command.activationId,
          },
        }),
      ]);
      const view = event === undefined ? null : (await repository.load(id)).view;
      if (view === null)
        throw new Error(`Artifact work item ${command.workItemId} was not created`);
      return view;
    },
    async get(workItemId) {
      return (await repository.load(artifactWorkItemIdForWorkItem(workItemId as never))).view;
    },
    read: (location) => store.read(location),
  };
}
