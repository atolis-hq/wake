import { resolve } from 'node:path';

import type { DockerCli } from '../adapters/docker/docker-cli.js';
import type { WakeConfig } from '../domain/types.js';

export async function runSandboxCommand(input: {
  args: string[];
  config: WakeConfig;
  repoRoot: string;
  wakeRoot: string;
  containerHomeRoot: string;
  docker: DockerCli;
}): Promise<void> {
  const subcommand = input.args[0];

  if (subcommand === 'build') {
    await input.docker.build({
      image: input.config.sandbox.image,
      dockerfile: resolve(input.repoRoot, 'docker', 'Dockerfile'),
      contextDir: input.repoRoot,
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
    await input.docker.exec(input.config.sandbox.containerName, input.args.slice(1));
    return;
  }

  if (subcommand === 'resume') {
    throw new Error('Sandbox resume is not implemented yet.');
  }

  throw new Error(`Unknown sandbox command: ${subcommand ?? ''}`.trimEnd());
}
