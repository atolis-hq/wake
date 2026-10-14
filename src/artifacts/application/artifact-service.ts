import { EventSourceKind, type CommandContext } from '@atolis-hq/eventing';
import type { WorkItemId } from '../../work/index.js';
import type { ArtifactsConfig } from '../contracts/config.js';
import {
  artifactSharedContextNameSchema,
  type ArtifactRevisionReference,
} from '../contracts/context.js';
import { createArtifactEventData } from '../contracts/event-factory.js';
import { ArtifactEventType } from '../contracts/events.js';
import { artifactWorkItemIdForWorkItem } from '../contracts/identifiers.js';
import {
  agentArtifactPath,
  isOperatorInstructionsPath,
  type ArtifactPath,
} from '../contracts/paths.js';
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
    acceptedActivation: (activationId: string, workItemId?: string) => Promise<boolean>,
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
    acceptedActivation: (activationId: string, workItemId?: string) => Promise<boolean>,
  ): Promise<ReadonlyArray<ArtifactVisibleRevision>>;
  read(location: string): Promise<Uint8Array>;
}

export type ArtifactVisibleRevision = ArtifactWorkItemView['revisions'][number] & {
  readonly workItemId: WorkItemId;
  readonly access: 'local' | 'shared';
  readonly currentMemory?: true;
};

export interface StageArtifactRevision {
  readonly revisionId: string;
  readonly path: ArtifactPath | string;
  readonly bytes: Uint8Array;
  readonly mediaType?: string;
  readonly share?: boolean;
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
  readonly contextScope?: string;
}

export interface ArtifactReadScope extends ArtifactWriteScope {
  readonly readableProducers: ReadonlySet<string>;
  readonly sharedReferences?: readonly ArtifactRevisionReference[];
  readonly currentMemory?: ArtifactRevisionReference | null;
}

// The public service keeps the tightly coupled idempotent staging operations adjacent.
// eslint-disable-next-line max-lines-per-function
export function createArtifactService(
  journal: ConstructorParameters<typeof ArtifactRepository>[0],
  store: FileArtifactStore,
  config: ArtifactsConfig,
): ArtifactService {
  const repository = new ArtifactRepository(journal);

  // A shared reference resolves only to a live revision whose owner's activation was accepted.
  async function sharedRevision(
    reference: ArtifactRevisionReference,
    currentMemory: ArtifactRevisionReference | null | undefined,
    acceptedActivation: (activationId: string, workItemId?: string) => Promise<boolean>,
  ): Promise<ArtifactVisibleRevision | null> {
    const owner = await repository.load(artifactWorkItemIdForWorkItem(reference.workItemId));
    const revision = owner.view?.revisions.find(
      (candidate) => candidate.revisionId === reference.revisionId,
    );
    if (
      revision === undefined ||
      isOperatorInstructionsPath(revision.path) ||
      revision.deleted ||
      !(await acceptedActivation(revision.activationId, reference.workItemId))
    )
      return null;
    return {
      ...revision,
      workItemId: reference.workItemId,
      access: 'shared',
      ...(currentMemory !== null &&
      currentMemory !== undefined &&
      sameRevision(currentMemory, reference)
        ? { currentMemory: true as const }
        : {}),
    };
  }

  async function appendShared(
    local: ArtifactVisibleRevision[],
    scope: ArtifactReadScope,
    acceptedActivation: (activationId: string, workItemId?: string) => Promise<boolean>,
  ): Promise<ArtifactVisibleRevision[]> {
    for (const reference of scope.sharedReferences ?? []) {
      const shared = await sharedRevision(reference, scope.currentMemory, acceptedActivation);
      if (shared !== null && !local.some((candidate) => sameRevision(candidate, reference)))
        local.push(shared);
    }
    return local;
  }

  return {
    async stageRevision(command, scope, context) {
      const id = artifactWorkItemIdForWorkItem(scope.workItemId as never);
      const loaded = await repository.load(id);
      if (loaded.view?.revisions.some((revision) => revision.revisionId === command.revisionId))
        return loaded.view;
      if (command.bytes.byteLength > config.maxWriteBytes)
        throw new Error(`Artifact write exceeds ${config.maxWriteBytes} byte limit`);
      const retained =
        loaded.view?.revisions.reduce((total, revision) => total + (revision.byteLength ?? 0), 0) ??
        0;
      if (retained + command.bytes.byteLength > config.maxWorkItemBytes)
        throw new Error(`Artifact work item exceeds ${config.maxWorkItemBytes} byte limit`);
      const selectedExport = contextExport(command.share, scope.contextScope);
      const path = agentArtifactPath(String(command.path));
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
            ...selectedExport,
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
            path: agentArtifactPath(String(command.path)),
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
        if (
          isOperatorInstructionsPath(revision.path) ||
          !(await acceptedActivation(revision.activationId))
        )
          continue;
        latest.set(`${revision.producer}\u0000${revision.path}`, revision);
      }
      for (const revision of latest.values()) if (!revision.deleted) visible.push(revision);
      return visible;
    },
    async visibleTo(scope, acceptedActivation) {
      const view = await repository.load(artifactWorkItemIdForWorkItem(scope.workItemId as never));
      const latest = new Map<string, ArtifactWorkItemView['revisions'][number]>();
      for (const revision of view.view?.revisions ?? []) {
        if (isOperatorInstructionsPath(revision.path)) continue;
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
      const local: ArtifactVisibleRevision[] = [...latest.values()]
        .filter((revision) => !revision.deleted)
        .map((revision) => ({ ...revision, workItemId: scope.workItemId, access: 'local' }));
      return appendShared(local, scope, acceptedActivation);
    },
    async readAcceptedRevision(workItemId, revisionId, acceptedActivation) {
      const view = await repository.load(artifactWorkItemIdForWorkItem(workItemId as never));
      const revision = (view.view?.revisions ?? []).find(
        (candidate) => candidate.revisionId === revisionId,
      );
      if (
        revision === undefined ||
        isOperatorInstructionsPath(revision.path) ||
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

function sameRevision(
  left: { readonly workItemId: string; readonly revisionId: string },
  right: { readonly workItemId: string; readonly revisionId: string },
): boolean {
  return left.workItemId === right.workItemId && left.revisionId === right.revisionId;
}

function contextExport(share: boolean | undefined, contextScope: string | undefined) {
  if (share !== true) return {};
  if (contextScope === undefined)
    throw new Error(
      'This run has no trusted shared context, so share is not available. Write the artifact again without share: it stays readable by later stages of this WorkItem.',
    );
  return { contextExport: artifactSharedContextNameSchema.parse(contextScope) };
}
