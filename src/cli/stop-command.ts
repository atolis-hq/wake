import type { RunRecord } from '../domain/types.js';

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const STOP_GRACE_PERIOD_SECONDS = 60;

export async function waitForActiveRuns(input: {
  listRunRecords: () => Promise<RunRecord[]>;
  sleep: (ms: number) => Promise<void>;
  pollIntervalMs?: number | undefined;
  timeoutMs?: number | undefined;
  logger: { info: (message: string) => void };
}): Promise<void> {
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const startedAt = Date.now();

  for (;;) {
    const records = await input.listRunRecords();
    const activeRuns = records.filter((record) => record.status === 'running');

    if (activeRuns.length === 0) {
      return;
    }

    if (input.timeoutMs !== undefined && Date.now() - startedAt >= input.timeoutMs) {
      throw new Error(
        `Timed out after ${input.timeoutMs}ms waiting for active runs to finish: ${activeRuns
          .map((record) => record.runId)
          .join(', ')}`,
      );
    }

    input.logger.info(
      `[wake stop] waiting for ${activeRuns.length} active run(s) to finish: ${activeRuns
        .map((record) => record.runId)
        .join(', ')}`,
    );
    await input.sleep(pollIntervalMs);
  }
}

function readNumberFlag(name: string, args: string[]): number | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }

  const raw = args[index + 1];
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function runStopCommand(input: {
  args: string[];
  stateStore: { listRunRecords: () => Promise<RunRecord[]> };
  docker: { down: (containerName: string, options?: { timeoutSeconds?: number }) => Promise<void> };
  containerName: string;
  sleep: (ms: number) => Promise<void>;
  logger: { info: (message: string) => void };
}): Promise<void> {
  await waitForActiveRuns({
    listRunRecords: input.stateStore.listRunRecords,
    sleep: input.sleep,
    pollIntervalMs: readNumberFlag('--poll-interval-ms', input.args),
    timeoutMs: readNumberFlag('--timeout-ms', input.args),
    logger: input.logger,
  });

  input.logger.info(`[wake stop] no active runs; stopping ${input.containerName}`);
  await input.docker.down(input.containerName, { timeoutSeconds: STOP_GRACE_PERIOD_SECONDS });
}
