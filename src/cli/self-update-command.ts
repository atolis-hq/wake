import { waitForActiveRuns } from './stop-command.js';
import type { SelfUpdateLedger } from '../adapters/fs/self-update-ledger.js';
import type { RunRecord } from '../domain/types.js';

const HEALTHCHECK_WAKE_ROOT = '/tmp/wake-self-update-healthcheck';
const START_PROCESS_CHECK_ATTEMPTS = 15;
const START_PROCESS_CHECK_INTERVAL_MS = 1000;
const START_PROCESS_CHECK = [
  'sh',
  '-lc',
  [
    'pid="$(cat /wake/.wake/logs/start.pid)"',
    'test -n "$pid"',
    'kill -0 "$pid"',
    'tr "\\0" " " < "/proc/$pid/cmdline" | grep -F "node /app/dist/src/main.js start --wake-root /wake" >/dev/null',
  ].join(' && '),
];

function readFlag(name: string, args: string[]): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function hasFlag(name: string, args: string[]): boolean {
  return args.includes(name);
}

function readNumberFlag(name: string, args: string[]): number | undefined {
  const raw = readFlag(name, args);
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const DEFAULT_LOOP_INTERVAL_MS = 5 * 60 * 1000;

async function verifyResidentStart(input: {
  docker: { exec: (containerName: string, command: string[]) => Promise<void> };
  containerName: string;
  start?: { enabled: boolean } | undefined;
  logger: { info: (message: string) => void; error: (message: string) => void };
  sleep: (ms: number) => Promise<void>;
  context: string;
}): Promise<void> {
  if (input.start?.enabled !== true) {
    input.logger.error(
      `[self-update] wake start auto-start is disabled; resident loop will not be running after ${input.context}`,
    );
    return;
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= START_PROCESS_CHECK_ATTEMPTS; attempt += 1) {
    try {
      await input.docker.exec(input.containerName, START_PROCESS_CHECK);
      input.logger.info(`[self-update] verified wake start is running after ${input.context}`);
      return;
    } catch (error) {
      lastError = error;
      if (attempt === START_PROCESS_CHECK_ATTEMPTS) {
        break;
      }
      await input.sleep(START_PROCESS_CHECK_INTERVAL_MS);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function runSelfUpdateCommand(input: {
  args: string[];
  repoRoot: string;
  imageRepository: string;
  containerName: string;
  stateStore: { listRunRecords: () => Promise<RunRecord[]> };
  docker: {
    build: (options: { image: string; dockerfile: string; contextDir: string }) => Promise<void>;
    update: (options: {
      image: string;
      containerName: string;
      wakeRoot: string;
      containerHomeRoot: string;
      containerMountPath: string;
      containerHomeMountPath: string;
      ui?: { enabled: boolean; port: number; token?: string | undefined } | undefined;
      start?: { enabled: boolean } | undefined;
    }) => Promise<void>;
    exec: (containerName: string, command: string[]) => Promise<void>;
  };
  git: {
    latestTag: () => Promise<string>;
    isWorkingTreeClean: () => Promise<boolean>;
    checkoutTag: (tag: string) => Promise<void>;
  };
  issueReporter: { createIssue: (issue: { title: string; body: string }) => Promise<void> };
  readLedger: () => Promise<SelfUpdateLedger>;
  writeLedger: (ledger: SelfUpdateLedger) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  logger: { info: (message: string) => void; error: (message: string) => void };
  wakeRoot: string;
  containerHomeRoot: string;
  containerMountPath: string;
  containerHomeMountPath: string;
  dockerfilePath: string;
  ui?: { enabled: boolean; port: number; token?: string | undefined } | undefined;
  start?: { enabled: boolean } | undefined;
}): Promise<void> {
  const force = hasFlag('--force', input.args);
  const explicitTag = readFlag('--tag', input.args);
  const ledger = await input.readLedger();

  const tag = explicitTag ?? (await input.git.latestTag());

  if (!force && tag === ledger.lastAppliedTag) {
    input.logger.info(`[self-update] already on ${tag}; nothing to do`);
    return;
  }

  if (!force && ledger.badTags.some((bad) => bad.tag === tag)) {
    input.logger.info(
      `[self-update] ${tag} is recorded as a bad tag; skipping (use --force to retry)`,
    );
    return;
  }

  if (!(await input.git.isWorkingTreeClean())) {
    throw new Error(
      `[self-update] repo working tree has local changes; refusing to update to ${tag}`,
    );
  }

  await waitForActiveRuns({
    listRunRecords: input.stateStore.listRunRecords,
    sleep: input.sleep,
    logger: input.logger,
  });

  const newImage = `${input.imageRepository}:${tag}`;
  const updateInput = {
    containerName: input.containerName,
    wakeRoot: input.wakeRoot,
    containerHomeRoot: input.containerHomeRoot,
    containerMountPath: input.containerMountPath,
    containerHomeMountPath: input.containerHomeMountPath,
    ui: input.ui,
    start: input.start,
  };

  try {
    await input.git.checkoutTag(tag);
    await input.docker.build({
      image: newImage,
      dockerfile: input.dockerfilePath,
      contextDir: input.repoRoot,
    });
    await input.docker.update({ ...updateInput, image: newImage });
    input.logger.info('[self-update] recreated container; entrypoint will keep wake start running');
    await verifyResidentStart({
      docker: input.docker,
      containerName: input.containerName,
      start: input.start,
      logger: input.logger,
      sleep: input.sleep,
      context: 'rollout',
    });
    await input.docker.exec(input.containerName, [
      'node',
      '/app/dist/src/main.js',
      'tick',
      '--wake-root',
      HEALTHCHECK_WAKE_ROOT,
    ]);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    input.logger.error(`[self-update] rollout of ${tag} failed: ${reason}`);

    if (ledger.lastKnownGoodTag !== null) {
      const rollbackImage = `${input.imageRepository}:${ledger.lastKnownGoodTag}`;
      await input.git.checkoutTag(ledger.lastKnownGoodTag);
      await input.docker.update({ ...updateInput, image: rollbackImage });
      input.logger.info(
        '[self-update] recreated rollback container; entrypoint will keep wake start running',
      );
      await verifyResidentStart({
        docker: input.docker,
        containerName: input.containerName,
        start: input.start,
        logger: input.logger,
        sleep: input.sleep,
        context: 'rollback',
      });
      input.logger.info(`[self-update] rolled back to ${ledger.lastKnownGoodTag}`);
    } else {
      input.logger.error('[self-update] no previous known-good tag to roll back to');
    }

    await input.writeLedger({
      lastAppliedTag: ledger.lastKnownGoodTag,
      lastKnownGoodTag: ledger.lastKnownGoodTag,
      badTags: [...ledger.badTags, { tag, reason, recordedAt: new Date().toISOString() }],
    });

    try {
      await input.issueReporter.createIssue({
        title: `Self-update to ${tag} failed and was rolled back`,
        body: [
          `Automated update to \`${tag}\` failed during rollout and was rolled back to \`${ledger.lastKnownGoodTag ?? 'unknown'}\`.`,
          '',
          '```',
          reason,
          '```',
        ].join('\n'),
      });
    } catch (issueError) {
      // Rollback already succeeded above; a failure to file the notification
      // issue must not be reported as an overall self-update failure.
      input.logger.error(
        `[self-update] rolled back successfully, but failed to file a GitHub issue: ${
          issueError instanceof Error ? issueError.message : String(issueError)
        }`,
      );
    }

    return;
  }

  await input.writeLedger({
    lastAppliedTag: tag,
    lastKnownGoodTag: tag,
    badTags: ledger.badTags,
  });
  input.logger.info(`[self-update] ${tag} is live and healthy`);
}

// Runs runSelfUpdateCommand forever, polling for a new tag every
// --loop-interval-ms (default 5 minutes). One failed iteration (e.g. a
// transient git/docker error) is logged and does not stop the loop — the
// next iteration retries. Exits only if `sleep` itself rejects (e.g. the
// process is being torn down), matching the resident-loop shape in
// core/control-plane.ts.
export async function runSelfUpdateLoop(
  input: Parameters<typeof runSelfUpdateCommand>[0],
): Promise<void> {
  const loopIntervalMs =
    readNumberFlag('--loop-interval-ms', input.args) ?? DEFAULT_LOOP_INTERVAL_MS;

  for (;;) {
    try {
      await runSelfUpdateCommand(input);
    } catch (error) {
      input.logger.error(
        `[self-update] loop iteration failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    input.logger.info(`[self-update] next check in ${loopIntervalMs}ms`);
    await input.sleep(loopIntervalMs);
  }
}
