import { mkdir } from 'node:fs/promises';
import { posix, resolve } from 'node:path';

import type { DockerCli } from '../adapters/docker/docker-cli.js';
import { createRunnerCliAdapter } from '../adapters/runner/runner-cli-adapter.js';
import type { RunnerEntry, RunRecord } from '../domain/types.js';
import { runSandboxResumeCommand } from './sandbox-resume.js';
import { runStopCommand } from './stop-command.js';
import {
  buildSandboxLoggedCommand,
} from './sandbox-logging.js';
import type { WakeConfig } from '../domain/types.js';

async function ensureContainerHomeMountParents(input: {
  containerHomeRoot: string;
  containerHomeMountPath: string;
  extraMounts: WakeConfig['sandbox']['extraMounts'];
}): Promise<void> {
  for (const mount of input.extraMounts) {
    const relativeTarget = posix.relative(input.containerHomeMountPath, mount.target);
    if (
      relativeTarget.length === 0 ||
      relativeTarget === '.' ||
      relativeTarget.startsWith('..')
    ) {
      continue;
    }

    const parentRelativeTarget = posix.dirname(relativeTarget);
    await mkdir(resolve(input.containerHomeRoot, parentRelativeTarget), {
      recursive: true,
    });
  }
}

function readFlag(name: string, args: string[]): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }

  return args[index + 1];
}

function uiDockerInput(config: WakeConfig): { enabled: boolean; port: number; token?: string | undefined } {
  return {
    enabled: config.ui.enabled,
    port: config.ui.port,
    token: config.ui.token,
  };
}

export async function runSandboxCommand(input: {
  args: string[];
  config: WakeConfig;
  wakeRoot: string;
  containerHomeRoot: string;
  docker: DockerCli;
  stateStore: { listRunRecords: () => Promise<RunRecord[]> };
  sleep: (ms: number) => Promise<void>;
  logger: { info: (message: string) => void; error?: (message: string) => void };
}): Promise<void> {
  const subcommand = input.args[0];

  if (subcommand === undefined) {
    throw new Error('Unknown sandbox command:');
  }

  if (subcommand === 'build') {
    const repoRoot = input.config.dev?.repoRoot;
    if (repoRoot === undefined || repoRoot.length === 0) {
      throw new Error('Sandbox build requires config.dev.repoRoot');
    }

    await input.docker.build({
      image: input.config.sandbox.image,
      dockerfile: resolve(repoRoot, 'docker', 'Dockerfile'),
      contextDir: repoRoot,
    });
    return;
  }

  if (subcommand === 'up') {
    await ensureContainerHomeMountParents({
      containerHomeRoot: input.containerHomeRoot,
      containerHomeMountPath: input.config.sandbox.containerHomeMountPath,
      extraMounts: input.config.sandbox.extraMounts,
    });
    await input.docker.up({
      image: input.config.sandbox.image,
      containerName: input.config.sandbox.containerName,
      wakeRoot: input.wakeRoot,
      containerHomeRoot: input.containerHomeRoot,
      containerMountPath: input.config.sandbox.containerMountPath,
      containerHomeMountPath: input.config.sandbox.containerHomeMountPath,
      extraMounts: input.config.sandbox.extraMounts,
      ui: uiDockerInput(input.config),
    });
    return;
  }

  if (subcommand === 'update') {
    await ensureContainerHomeMountParents({
      containerHomeRoot: input.containerHomeRoot,
      containerHomeMountPath: input.config.sandbox.containerHomeMountPath,
      extraMounts: input.config.sandbox.extraMounts,
    });
    await input.docker.update({
      image: input.config.sandbox.image,
      containerName: input.config.sandbox.containerName,
      wakeRoot: input.wakeRoot,
      containerHomeRoot: input.containerHomeRoot,
      containerMountPath: input.config.sandbox.containerMountPath,
      containerHomeMountPath: input.config.sandbox.containerHomeMountPath,
      extraMounts: input.config.sandbox.extraMounts,
      ui: uiDockerInput(input.config),
    });
    return;
  }

  if (subcommand === 'down') {
    await input.docker.down(input.config.sandbox.containerName);
    return;
  }

  if (subcommand === 'stop') {
    await runStopCommand({
      args: input.args.slice(1),
      stateStore: input.stateStore,
      docker: input.docker,
      containerName: input.config.sandbox.containerName,
      sleep: input.sleep,
      logger: input.logger,
    });
    return;
  }

  if (subcommand === 'setup') {
    await input.docker.exec(
      input.config.sandbox.containerName,
      ['bash', '/wake/docker/setup.sh'],
      { interactive: true },
    );
    return;
  }

  if (subcommand === 'exec') {
    const commandArgs = input.args.slice(1);
    const wrappedCommand = commandArgs[0] === '--' ? commandArgs.slice(1) : commandArgs;
    await input.docker.exec(
      input.config.sandbox.containerName,
      wrappedCommand.length === 0
        ? []
        : buildSandboxLoggedCommand({
            label: 'sandbox.exec',
            config: input.config,
            wakeRoot: input.wakeRoot,
            containerHomeRoot: input.containerHomeRoot,
            command: wrappedCommand,
          }),
    );
    return;
  }

  if (subcommand === 'logs') {
    const tailLines = Number.parseInt(readFlag('--tail', input.args) ?? '200', 10);
    await input.docker.logs(
      input.config.sandbox.containerName,
      Number.isFinite(tailLines) && tailLines > 0 ? tailLines : 200,
    );
    return;
  }

  if (subcommand === 'resume') {
    const realEntry = Object.values(input.config.runners).find(
      (e): e is Exclude<RunnerEntry, { kind: 'fake' }> => e.kind !== 'fake',
    );
    if (realEntry === undefined) {
      throw new Error('Sandbox resume requires a real runner entry (`claude` or `codex`) in config.runners.');
    }

    const runnerAdapter = createRunnerCliAdapter({
      entry: realEntry,
      cwd: process.cwd(),
    });
    await runSandboxResumeCommand({
      args: input.args.slice(1),
      config: input.config,
      docker: input.docker,
      wakeRoot: input.wakeRoot,
      containerHomeRoot: input.containerHomeRoot,
      buildResumeCommand: runnerAdapter.buildResumeCommand,
    });
    return;
  }

  throw new Error(`Unknown sandbox command: ${subcommand}`.trimEnd());
}
