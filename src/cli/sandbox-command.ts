import { resolve } from 'node:path';

import type { DockerCli } from '../adapters/docker/docker-cli.js';
import { runSandboxResumeCommand } from './sandbox-resume.js';
import type { WakeConfig } from '../domain/types.js';

export async function runSandboxCommand(input: {
  args: string[];
  config: WakeConfig;
  wakeRoot: string;
  containerHomeRoot: string;
  docker: DockerCli;
}): Promise<void> {
  const subcommand = input.args[0];

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
    });
    return;
  }

  if (subcommand === 'down') {
    await input.docker.down(input.config.sandbox.containerName);
    return;
  }

  if (subcommand === 'setup') {
    await input.docker.setup(input.config.sandbox.containerName);
    return;
  }

  if (subcommand === 'exec') {
    const commandArgs = input.args.slice(1);
    await input.docker.exec(
      input.config.sandbox.containerName,
      commandArgs[0] === '--' ? commandArgs.slice(1) : commandArgs,
    );
    return;
  }

  if (subcommand === 'resume') {
    await runSandboxResumeCommand({
      args: input.args.slice(1),
      config: input.config,
      docker: input.docker,
      wakeRoot: input.wakeRoot,
    });
    return;
  }

  throw new Error(`Unknown sandbox command: ${subcommand ?? ''}`.trimEnd());
}
