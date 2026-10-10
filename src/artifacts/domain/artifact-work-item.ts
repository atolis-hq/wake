import {
  ArtifactEventType,
  type ArtifactEvent,
  type ArtifactEventPayloads,
} from '../contracts/events.js';
import type { ArtifactWorkItemView } from '../contracts/views.js';

export function foldArtifactWorkItem(
  events: readonly ArtifactEvent[],
): ArtifactWorkItemView | null {
  let view: ArtifactWorkItemView | null = null;
  for (const event of events) view = applyArtifactEvent(view, event);
  return view;
}

export function applyArtifactEvent(
  view: ArtifactWorkItemView | null,
  event: ArtifactEvent,
): ArtifactWorkItemView {
  const payload = event.event.payload;
  const current = view ?? {
    artifactWorkItemId: event.stream.id,
    workItemId: payload.workItemId,
    revisions: [],
  };
  if (current.revisions.some((revision) => revision.revisionId === payload.revisionId))
    return current;
  const common = {
    revisionId: payload.revisionId,
    producer: payload.producer,
    path: payload.path,
    runId: payload.runId,
    activationId: payload.activationId,
    occurredAt: event.event.occurredAt,
  };
  if (event.event.eventType === ArtifactEventType.TombstoneStaged)
    return { ...current, revisions: [...current.revisions, { ...common, deleted: true }] };
  const revision = payload as ArtifactEventPayloads[typeof ArtifactEventType.RevisionStaged];
  return {
    ...current,
    revisions: [
      ...current.revisions,
      {
        ...common,
        deleted: false,
        location: revision.location,
        digest: revision.digest,
        byteLength: revision.byteLength,
        ...(revision.mediaType === undefined ? {} : { mediaType: revision.mediaType }),
      },
    ],
  };
}
