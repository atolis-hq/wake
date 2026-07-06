import { resolve } from 'node:path';

import type { DockerCli } from '../adapters/docker/docker-cli.js';
import { runSandboxResumeCommand } from './sandbox-resume.js';
import {
  buildSandboxLoggedCommand,
} from './sandbox-logging.js';
import type { WakeConfig } from '../domain/types.js';

function readFlag(name: string, args: string[]): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }

  return args[index + 1];
}

export async function runSandboxCommand(input: {
  args: string[];
  config: WakeConfig;
  wakeRoot: string;
  containerHomeRoot: string;
  docker: DockerCli;
}): Promise<void> {
  const subcommand = input.args[0];

  if (subcommand === undefined) {
    throw new Error('Unknown sandbox command:');
  }

  try {
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
      await input.docker.up({
        image: input.config.sandbox.image,
        containerName: input.config.sandbox.containerName,
        wakeRoot: input.wakeRoot,
        containerHomeRoot: input.containerHomeRoot,
        containerMountPath: input.config.sandbox.containerMountPath,
        containerHomeMountPath: input.config.sandbox.containerHomeMountPath,
        extraMounts: input.config.sandbox.extraMounts,
      });
      return;
    }

    if (subcommand === 'update') {
      await input.docker.update({
        image: input.config.sandbox.image,
        containerName: input.config.sandbox.containerName,
        wakeRoot: input.wakeRoot,
        containerHomeRoot: input.containerHomeRoot,
        containerMountPath: input.config.sandbox.containerMountPath,
        containerHomeMountPath: input.config.sandbox.containerHomeMountPath,
        extraMounts: input.config.sandbox.extraMounts,
      });
      return;
    }

    if (subcommand === 'down') {
      await input.docker.down(input.config.sandbox.containerName);
      return;
    }

    if (subcommand === 'setup') {
      await input.docker.execInteractive(
        input.config.sandbox.containerName,
        ['bash', '/wake/docker/setup.sh'],
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
      await runSandboxResumeCommand({
        args: input.args.slice(1),
        config: input.config,
        docker: input.docker,
        wakeRoot: input.wakeRoot,
        containerHomeRoot: input.containerHomeRoot,
      });
      return;
    }

    throw new Error(`Unknown sandbox command: ${subcommand}`.trimEnd());
  } catch (error) {
    throw error;
  }
}
