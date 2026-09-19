import { EventSourceKind, type CommandContext } from '@atolis-hq/eventing';
import type { WorkItemId } from '../../work/index.js';
import type { ArtifactsConfig } from '../contracts/config.js';
import { createArtifactEventData } from '../contracts/event-factory.js';
import { ArtifactEventType } from '../contracts/events.js';
import { artifactWorkItemIdForWorkItem } from '../contracts/identifiers.js';
import { artifactPath, type ArtifactPath } from '../contracts/paths.js';
import type { ArtifactWorkItemView } from '../contracts/views.js';
import type { FileArtifactStore } from '../infrastructure/file-artifact-store.js';
import { ArtifactRepository } from './artifact-repository.js';

export interface ArtifactService {
  stageRevision(
    command: StageArtifactRevision,
    scope: ArtifactWriteScope,
    context: CommandContext,
  ): Promise<ArtifactWorkItemView>;
  stageTombstone(
    command: StageArtifactTombstone,
    scope: ArtifactWriteScope,
    context: CommandContext,
  ): Promise<ArtifactWorkItemView>;
  get(workItemId: string): Promise<ArtifactWorkItemView | null>;
  latestPublished(
    workItemId: string,
    acceptedActivation: (activationId: string) => Promise<boolean>,
  ): Promise<ReadonlyArray<ArtifactWorkItemView['revisions'][number]>>;
  readAcceptedRevision(
    workItemId: string,
    revisionId: string,
    acceptedActivation: (activationId: string) => Promise<boolean>,
  ): Promise<{
    readonly revision: ArtifactWorkItemView['revisions'][number];
    readonly bytes: Uint8Array;
  } | null>;
  visibleTo(
    scope: ArtifactReadScope,
    acceptedActivation: (activationId: string) => Promise<boolean>,
  ): Promise<ReadonlyArray<ArtifactWorkItemView['revisions'][number]>>;
  read(location: string): Promise<Uint8Array>;
}

export interface StageArtifactRevision {
  readonly revisionId: string;
  readonly path: ArtifactPath | string;
  readonly bytes: Uint8Array;
  readonly mediaType?: string;
}

export interface StageArtifactTombstone {
  readonly revisionId: string;
  readonly path: ArtifactPath | string;
}

/** Trusted execution context, never supplied by an MCP tool request. */
export interface ArtifactWriteScope {
  readonly workItemId: WorkItemId;
  readonly producer: string;
  readonly runId: string;
  readonly activationId: string;
}

export interface ArtifactReadScope extends ArtifactWriteScope {
  readonly readableProducers: ReadonlySet<string>;
}

// The public service keeps the tightly coupled idempotent staging operations adjacent.
// eslint-disable-next-line max-lines-per-function
export function createArtifactService(
  journal: ConstructorParameters<typeof ArtifactRepository>[0],
  store: FileArtifactStore,
  config: ArtifactsConfig,
): ArtifactService {
  const repository = new ArtifactRepository(journal);
  return {
    async stageRevision(command, scope, context) {
      if (command.bytes.byteLength > config.maxWriteBytes)
        throw new Error(`Artifact write exceeds ${config.maxWriteBytes} byte limit`);
      const id = artifactWorkItemIdForWorkItem(scope.workItemId as never);
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
        workItemId: scope.workItemId,
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
            workItemId: scope.workItemId,
            revisionId: command.revisionId,
            producer: scope.producer,
            path,
            runId: scope.runId,
            activationId: scope.activationId,
            ...stored,
            ...(command.mediaType === undefined ? {} : { mediaType: command.mediaType }),
          },
        }),
      ]);
      const view = event === undefined ? null : (await repository.load(id)).view;
      if (view === null) throw new Error(`Artifact work item ${scope.workItemId} was not created`);
      return view;
    },
    async stageTombstone(command, scope, context) {
      const id = artifactWorkItemIdForWorkItem(scope.workItemId as never);
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
            workItemId: scope.workItemId,
            revisionId: command.revisionId,
            producer: scope.producer,
            path: artifactPath(String(command.path)),
            runId: scope.runId,
            activationId: scope.activationId,
          },
        }),
      ]);
      const view = event === undefined ? null : (await repository.load(id)).view;
      if (view === null) throw new Error(`Artifact work item ${scope.workItemId} was not created`);
      return view;
    },
    async get(workItemId) {
      return (await repository.load(artifactWorkItemIdForWorkItem(workItemId as never))).view;
    },
    async latestPublished(workItemId, acceptedActivation) {
      const view = await repository.load(artifactWorkItemIdForWorkItem(workItemId as never));
      const visible = [] as ArtifactWorkItemView['revisions'][number][];
      const latest = new Map<string, ArtifactWorkItemView['revisions'][number]>();
      for (const revision of view.view?.revisions ?? []) {
        if (!(await acceptedActivation(revision.activationId))) continue;
        latest.set(`${revision.producer}\u0000${revision.path}`, revision);
      }
      for (const revision of latest.values()) if (!revision.deleted) visible.push(revision);
      return visible;
    },
    async visibleTo(scope, acceptedActivation) {
      const view = await repository.load(artifactWorkItemIdForWorkItem(scope.workItemId as never));
      const latest = new Map<string, ArtifactWorkItemView['revisions'][number]>();
      for (const revision of view.view?.revisions ?? []) {
        const published =
          scope.readableProducers.has(revision.producer) &&
          (await acceptedActivation(revision.activationId));
        const ownStaged =
          revision.producer === scope.producer &&
          revision.runId === scope.runId &&
          revision.activationId === scope.activationId;
        if (published || ownStaged)
          latest.set(`${revision.producer}\u0000${revision.path}`, revision);
      }
      return [...latest.values()].filter((revision) => !revision.deleted);
    },
    async readAcceptedRevision(workItemId, revisionId, acceptedActivation) {
      const view = await repository.load(artifactWorkItemIdForWorkItem(workItemId as never));
      const revision = (view.view?.revisions ?? []).find(
        (candidate) => candidate.revisionId === revisionId,
      );
      if (
        revision === undefined ||
        revision.deleted ||
        revision.location === undefined ||
        !(await acceptedActivation(revision.activationId))
      )
        return null;
      return { revision, bytes: await store.read(revision.location) };
    },
    read: (location) => store.read(location),
  };
}
