import { TranscriptChannel, type RunView, type TranscriptStore } from '../execution/index.js';
import type {
  TranscriptEntryResponse,
  TranscriptGroupResponse,
  WorkItemTranscriptResponse,
} from '../surfaces/index.js';

export async function transcriptGroups(
  store: TranscriptStore | undefined,
  workItemId: string,
  runs: readonly RunView[],
): Promise<readonly TranscriptGroupResponse[]> {
  if (store === undefined) return [];
  const owned = new Set<string>(runs.map((run) => run.runId));
  const visible: readonly (TranscriptGroupResponse | undefined)[] = await Promise.all(
    (await store.listGroups(workItemId)).map(
      async (group): Promise<TranscriptGroupResponse | undefined> => {
        const messages = (await store.readGroup(workItemId, group.id)).filter((message) =>
          owned.has(message.runId),
        );
        const latest = messages.at(-1);
        if (latest === undefined) return undefined;
        return {
          groupId: group.id,
          kind: group.kind,
          ...(group.cli === undefined ? {} : { cli: group.cli }),
          latestAt: latest.timestamp,
          runIds: [...new Set(messages.map((message) => message.runId))],
        };
      },
    ),
  );
  return visible.filter((group): group is TranscriptGroupResponse => group !== undefined);
}

export async function readWorkTranscript(
  store: TranscriptStore | undefined,
  workItemId: string,
  groupId: string,
  runs: readonly RunView[],
): Promise<WorkItemTranscriptResponse> {
  if (store === undefined) return unavailable(groupId);
  const group = (await store.listGroups(workItemId)).find((item) => item.id === groupId);
  if (group === undefined) return unavailable(groupId);
  const included = new Set(group.runIds);
  const metadata = new Map<string, RunView>(
    runs.filter((run) => included.has(run.runId)).map((run) => [run.runId, run]),
  );
  if (metadata.size === 0) return unavailable(groupId);
  return {
    groupId,
    available: true,
    entries: (await store.readGroup(workItemId, groupId))
      .filter((message) => metadata.has(message.runId))
      .map((message) => presentEntry(message, groupId, metadata.get(message.runId))),
  };
}

function unavailable(groupId: string): WorkItemTranscriptResponse {
  return { groupId, available: false, entries: [] };
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
    channel: message.kind === 'prompt' ? TranscriptChannel.Input : TranscriptChannel.Agent,
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
