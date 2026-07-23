import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { join } from 'node:path';

import type { DockerCli } from '../adapters/docker/docker-cli.js';
import { listRunRecords } from '../adapters/fs/state-store.js';
import type { RunRecord, WakeConfig } from '../domain/types.js';

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function buildCwdWrappedShellCommand(cwd: string, command: string[]): string[] {
  const shellCommand = `cd ${shellQuote(cwd)} && ${command.map(shellQuote).join(' ')}`;
  return ['sh', '-c', shellCommand];
}

type ResumeTarget = {
  sessionId: string;
  workspacePath: string;
};

type ResumeOption = {
  label: string;
  value: ResumeTarget;
};

type ResumeSelector = (options: ResumeOption[]) => Promise<ResumeOption | null>;

function readFlag(name: string, args: string[]): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }

  return args[index + 1];
}

function compareRunRecordsDescending(left: RunRecord, right: RunRecord): number {
  const leftTimestamp = left.finishedAt ?? left.startedAt;
  const rightTimestamp = right.finishedAt ?? right.startedAt;
  return rightTimestamp.localeCompare(leftTimestamp);
}

export async function promptResumeSelection(options: ResumeOption[]): Promise<ResumeOption | null> {
  if (options.length === 0) {
    return null;
  }

  for (const [index, option] of options.entries()) {
    output.write(`${index + 1}. ${option.label}\n`);
  }

  const rl = createInterface({ input, output });

  try {
    const answer = (await rl.question('Select a resume target: ')).trim();
    const selection = Number.parseInt(answer, 10);
    if (!Number.isInteger(selection) || selection < 1 || selection > options.length) {
      return null;
    }

    return options[selection - 1] ?? null;
  } finally {
    rl.close();
  }
}

export async function chooseResumeTarget(input: {
  wakeRoot: string;
  select: ResumeSelector;
}): Promise<ResumeTarget | null> {
  const options = (await listRunRecords(input.wakeRoot))
    .filter((record) => record.sessionId !== undefined)
    .sort(compareRunRecordsDescending)
    .map((record) => ({
      label: `${record.repo}#${record.issueNumber} · ${record.action} · ${
        record.finishedAt ?? record.startedAt
      }`,
      value: {
        sessionId: record.sessionId as string,
        workspacePath: join(
          input.wakeRoot,
          'workspaces',
          record.repo.replace(/[\\/]/g, '__'),
          String(record.issueNumber),
        ),
      },
    }));

  const selected = await input.select(options);
  return selected?.value ?? null;
}

export async function runSandboxResumeCommand(input: {
  args: string[];
  config: WakeConfig;
  docker: Pick<DockerCli, 'execCaptured'>;
  wakeRoot: string;
  containerHomeRoot: string;
  select?: ResumeSelector;
  buildResumeCommand: (input: { sessionId: string }) => string[];
  logger: { info: (message: string) => void; error?: (message: string) => void };
}): Promise<void> {
  const sessionId = input.args[0];
  const explicitCwd = readFlag('--cwd', input.args);

  const target =
    sessionId !== undefined
      ? explicitCwd === undefined
        ? null
        : { sessionId, workspacePath: explicitCwd }
      : await chooseResumeTarget({
          wakeRoot: input.wakeRoot,
          select: input.select ?? promptResumeSelection,
        });

  if (target === null) {
    if (sessionId !== undefined && explicitCwd === undefined) {
      throw new Error('Sandbox resume requires --cwd when a session ID is provided.');
    }

    throw new Error('No resumable sandbox session selected.');
  }

  await input.docker.execCaptured(
    input.config.sandbox.containerName,
    buildCwdWrappedShellCommand(
      target.workspacePath,
      input.buildResumeCommand({ sessionId: target.sessionId }),
    ),
    {
      onStdout: (line) => input.logger.info(line),
      onStderr: (line) => (input.logger.error ?? input.logger.info)(line),
    },
  );
}
