import type { RuntimeEventDraft } from '../../domain/runtime-events.js';
import type { IssueStateRecord, RunnerRouting } from '../../domain/types.js';

function runnerKindForCli(cli: string): RuntimeEventDraft['runner']['kind'] {
  if (cli === 'Claude') {
    return 'claude';
  }
  if (cli === 'Codex') {
    return 'codex';
  }
  if (cli === 'Cursor') {
    return 'cursor';
  }
  return 'fake';
}

export function runnerRuntimeEvent(input: {
  type: RuntimeEventDraft['type'];
  runId: string;
  projection: IssueStateRecord;
  routing?: RunnerRouting | undefined;
  cli: string;
  model?: string | undefined;
  sessionId?: string | undefined;
  payload?: Record<string, unknown>;
}): RuntimeEventDraft {
  return {
    type: input.type,
    runId: input.runId,
    workItemId: input.projection.workItemKey,
    runner: {
      name: input.routing?.runnerName ?? input.cli.toLowerCase(),
      kind: input.routing?.runnerKind ?? runnerKindForCli(input.cli),
      cli: input.cli,
      ...(input.model === undefined ? {} : { model: input.model }),
    },
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    payload: input.payload ?? {},
  };
}

export async function emitRuntimeEvent(
  emit: ((event: RuntimeEventDraft) => Promise<void>) | undefined,
  event: RuntimeEventDraft,
): Promise<void> {
  if (emit !== undefined) {
    await emit(event);
  }
}
