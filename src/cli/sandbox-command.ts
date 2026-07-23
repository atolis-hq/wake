import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { posix, resolve } from 'node:path';

import type { DockerCli } from '../adapters/docker/docker-cli.js';
import type { SelfUpdateLedger } from '../adapters/fs/self-update-ledger.js';
import { createRunnerCliAdapter } from '../adapters/runner/runner-cli-adapter.js';
import type { RunnerEntry, RunRecord } from '../domain/types.js';
import { runSandboxResumeCommand } from './sandbox-resume.js';
import { runSelfUpdateCommand, runSelfUpdateLoop } from './self-update-command.js';
import { runStopCommand } from './stop-command.js';
import type { WakeConfig } from '../domain/types.js';
import { wakeVersion } from '../version.js';

async function ensureDockerfile(input: {
  wakeRoot: string;
  devMode: 'source' | 'packaged' | undefined;
  packagedTemplatesRoot: string;
}): Promise<void> {
  const targetPath = resolve(input.wakeRoot, 'docker', 'Dockerfile');

  try {
    await access(targetPath);
    return; // already present — user-owned, never overwritten
  } catch {
    // fall through to write it
  }

  const mode = input.devMode ?? 'packaged';
  const templatePath = resolve(
    input.packagedTemplatesRoot,
    mode === 'source' ? 'Dockerfile' : 'Dockerfile.packaged',
  );
  const content = await readFile(templatePath, 'utf8');

  await mkdir(resolve(input.wakeRoot, 'docker'), { recursive: true });
  await writeFile(targetPath, content, 'utf8');
}

async function ensureContainerHomeMountParents(input: {
  containerHomeRoot: string;
  containerHomeMountPath: string;
  extraMounts: WakeConfig['sandbox']['extraMounts'];
}): Promise<void> {
  for (const mount of input.extraMounts) {
    const relativeTarget = posix.relative(input.containerHomeMountPath, mount.target);
    if (relativeTarget.length === 0 || relativeTarget === '.' || relativeTarget.startsWith('..')) {
      continue;
    }

    const parentRelativeTarget = posix.dirname(relativeTarget);
    await mkdir(resolve(input.containerHomeRoot, parentRelativeTarget), {
      recursive: true,
    });
  }
}

const sandboxSubcommands = [
  ['build', 'Generate docker/Dockerfile (if missing) and build the sandbox image'],
  ['up', 'Start the sandbox container'],
  ['update', 'Recreate the sandbox container from the current image'],
  ['down', 'Stop and remove the sandbox container'],
  ['stop', 'Stop the resident loop gracefully, then the container'],
  ['self-update', 'Pull the latest tag and rebuild (source dev.mode only)'],
  ['setup', 'Run interactive first-time setup inside the container'],
  ['exec', 'Run a command inside the sandbox container'],
  ['logs', 'Print sandbox container logs'],
  ['resume', 'Resume a previous agent session inside the sandbox'],
] as const;

export function printSandboxUsage(stream: NodeJS.WritableStream): void {
  const width = Math.max(...sandboxSubcommands.map(([name]) => name.length));
  stream.write(
    [
      'Usage: wake sandbox <subcommand>',
      '',
      'Subcommands:',
      ...sandboxSubcommands.map(([name, description]) => `  ${name.padEnd(width)}  ${description}`),
      '',
    ].join('\n'),
  );
}

function readFlag(name: string, args: string[]): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }

  return args[index + 1];
}

function uiDockerInput(config: WakeConfig): {
  enabled: boolean;
  port: number;
  token?: string | undefined;
  tunnel?: { enabled: boolean; authToken?: string | undefined } | undefined;
} {
  return {
    enabled: config.ui.enabled,
    port: config.ui.port,
    token: config.ui.token,
    tunnel: config.ui.tunnel,
  };
}

function startDockerInput(config: WakeConfig): { enabled: boolean } {
  return {
    enabled: config.sandbox.start.enabled,
  };
}

export async function runSandboxCommand(input: {
  args: string[];
  config: WakeConfig;
  wakeRoot: string;
  containerHomeRoot: string;
  docker: DockerCli;
  packagedTemplatesRoot: string;
  stateStore: { listRunRecords: () => Promise<RunRecord[]> };
  sleep: (ms: number) => Promise<void>;
  logger: { info: (message: string) => void; error?: (message: string) => void };
  selfUpdate?:
    | {
        git: {
          latestTag: () => Promise<string>;
          isWorkingTreeClean: () => Promise<boolean>;
          checkoutTag: (tag: string) => Promise<void>;
        };
        issueReporter: { createIssue: (issue: { title: string; body: string }) => Promise<void> };
        readLedger: () => Promise<SelfUpdateLedger>;
        writeLedger: (ledger: SelfUpdateLedger) => Promise<void>;
      }
    | undefined;
}): Promise<void> {
  const subcommand = input.args[0];

  if (
    subcommand === undefined ||
    subcommand === '--help' ||
    subcommand === '-h' ||
    subcommand === 'help'
  ) {
    printSandboxUsage(process.stdout);
    return;
  }

  if (subcommand === 'build') {
    const repoRoot = input.config.dev?.repoRoot;
    if (repoRoot === undefined || repoRoot.length === 0) {
      throw new Error('Sandbox build requires config.dev.repoRoot');
    }

    const effectiveDevMode = input.config.dev?.mode ?? 'packaged';

    await ensureDockerfile({
      wakeRoot: input.wakeRoot,
      devMode: effectiveDevMode,
      packagedTemplatesRoot: input.packagedTemplatesRoot,
    });

    await input.docker.build({
      image: input.config.sandbox.image,
      dockerfile: resolve(input.wakeRoot, 'docker', 'Dockerfile'),
      contextDir: repoRoot,
      ...(effectiveDevMode === 'packaged' ? { buildArgs: { WAKE_VERSION: wakeVersion } } : {}),
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
      start: startDockerInput(input.config),
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
      start: startDockerInput(input.config),
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

  if (subcommand === 'self-update') {
    const repoRoot = input.config.dev?.repoRoot;
    if (repoRoot === undefined || repoRoot.length === 0) {
      throw new Error('Sandbox self-update requires config.dev.repoRoot');
    }
    if (input.selfUpdate === undefined) {
      throw new Error(
        'Sandbox self-update requires dev.mode: "source". For a packaged install, update instead with:\n' +
          '  npm install -g @atolis-hq/wake@latest && wake sandbox build && wake sandbox update',
      );
    }

    const selfUpdateArgs = input.args.slice(1);
    const runSelfUpdate = selfUpdateArgs.includes('--loop')
      ? runSelfUpdateLoop
      : runSelfUpdateCommand;

    await runSelfUpdate({
      args: selfUpdateArgs,
      repoRoot,
      imageRepository: input.config.sandbox.imageRepository,
      containerName: input.config.sandbox.containerName,
      stateStore: input.stateStore,
      docker: input.docker,
      git: input.selfUpdate.git,
      issueReporter: input.selfUpdate.issueReporter,
      readLedger: input.selfUpdate.readLedger,
      writeLedger: input.selfUpdate.writeLedger,
      sleep: input.sleep,
      logger: {
        info: input.logger.info,
        error: input.logger.error ?? input.logger.info,
      },
      wakeRoot: input.wakeRoot,
      containerHomeRoot: input.containerHomeRoot,
      containerMountPath: input.config.sandbox.containerMountPath,
      containerHomeMountPath: input.config.sandbox.containerHomeMountPath,
      dockerfilePath: resolve(repoRoot, 'docker', 'Dockerfile'),
      ui: uiDockerInput(input.config),
      start: startDockerInput(input.config),
    });
    return;
  }

  if (subcommand === 'setup') {
    const setupCommand =
      input.config.dev?.mode === 'source'
        ? ['node', '/app/dist/src/main.js', 'sandbox-setup']
        : ['wake', 'sandbox-setup'];
    await input.docker.exec(input.config.sandbox.containerName, setupCommand, {
      interactive: true,
    });
    return;
  }

  if (subcommand === 'exec') {
    const commandArgs = input.args.slice(1);
    const wrappedCommand = commandArgs[0] === '--' ? commandArgs.slice(1) : commandArgs;

    if (wrappedCommand.length === 0) {
      // No command given: drop into an interactive shell with a real TTY,
      // same as `docker exec -it ... bash`. That's a genuine interactive
      // use case, so it stays on the inherited-stdio path rather than the
      // piped/scrubbed one below (which would break TTY behavior).
      await input.docker.exec(input.config.sandbox.containerName, []);
      return;
    }

    await input.docker.execCaptured(input.config.sandbox.containerName, wrappedCommand, {
      onStdout: (line) => input.logger.info(line),
      onStderr: (line) => (input.logger.error ?? input.logger.info)(line),
    });
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
      throw new Error(
        'Sandbox resume requires a real runner entry (`claude` or `codex`) in config.runners.',
      );
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
      logger: input.logger,
    });
    return;
  }

  throw new Error(`Unknown sandbox command: ${subcommand}`.trimEnd());
}
