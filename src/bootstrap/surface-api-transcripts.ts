import type { RunView, TranscriptStore } from '../execution/index.js';
import type {
  TranscriptEntryResponse,
  TranscriptGroupResponse,
  WorkItemTranscriptResponse,
} from '../surfaces/index.js';

export async function transcriptGroups(
  store: TranscriptStore | undefined,
  workItemId: string,
): Promise<readonly TranscriptGroupResponse[]> {
  if (store === undefined) return [];
  return (await store.listGroups(workItemId)).map((group) => ({
    groupId: group.id,
    kind: group.kind,
    ...(group.cli === undefined ? {} : { cli: group.cli }),
    latestAt: group.latestAt,
    runIds: group.runIds,
  }));
}

export async function readWorkTranscript(
  store: TranscriptStore | undefined,
  workItemId: string,
  groupId: string,
  runs: readonly RunView[],
): Promise<WorkItemTranscriptResponse | undefined> {
  if (store === undefined) return undefined;
  const group = (await store.listGroups(workItemId)).find((item) => item.id === groupId);
  if (group === undefined) return undefined;
  const included = new Set(group.runIds);
  const metadata = new Map<string, RunView>(
    runs.filter((run) => included.has(run.runId)).map((run) => [run.runId, run]),
  );
  if (metadata.size === 0) return undefined;
  return {
    groupId,
    available: true,
    entries: (await store.readGroup(workItemId, groupId))
      .filter((message) => metadata.has(message.runId))
      .map((message) => presentEntry(message, groupId, metadata.get(message.runId))),
  };
}

export function presentEntry(
  message: {
    readonly timestamp: string;
    readonly runId: string;
    readonly kind: 'prompt' | 'response';
    readonly text: string;
  },
  groupId: string,
  run: RunView | undefined,
): TranscriptEntryResponse {
  const durationMs = runDuration(run);
  return {
    occurredAt: message.timestamp,
    channel: message.kind === 'prompt' ? 'input' : 'agent',
    text: message.text,
    runId: message.runId,
    groupId,
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}

function runDuration(run: RunView | undefined): number | undefined {
  if (run?.finishedAt === undefined) return undefined;
  return Date.parse(run.finishedAt) - Date.parse(run.startedAt);
}
