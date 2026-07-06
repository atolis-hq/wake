export type DockerContainerState = 'running' | 'stopped' | null;

export type DockerBuildInput = {
  image: string;
  dockerfile: string;
  contextDir: string;
};

export type DockerUpInput = {
  image: string;
  containerName: string;
  wakeRoot: string;
  containerHomeRoot: string;
  containerMountPath: string;
  containerHomeMountPath: string;
  extraMounts?: Array<{
    source: string;
    target: string;
    readOnly?: boolean | undefined;
  }>;
};

export type DockerCli = ReturnType<typeof createDockerCli>;

function buildRunArgs(input: DockerUpInput): string[] {
  return [
    'run',
    '-d',
    '--name',
    input.containerName,
    '-v',
    `${input.wakeRoot}:${input.containerMountPath}`,
    '-v',
    `${input.containerHomeRoot}:${input.containerHomeMountPath}`,
    ...(input.extraMounts ?? []).flatMap((mount) => [
      '-v',
      `${mount.source}:${mount.target}${mount.readOnly === true ? ':ro' : ''}`,
    ]),
    input.image,
  ];
}

export function createDockerCli(deps: {
  run(args: string[]): Promise<void>;
  inspectImage(image: string): Promise<boolean>;
  inspectContainer(containerName: string): Promise<DockerContainerState>;
}) {
  return {
    async build(input: DockerBuildInput): Promise<void> {
      await deps.run(['build', '-t', input.image, '-f', input.dockerfile, input.contextDir]);
    },

    async up(input: DockerUpInput): Promise<void> {
      const imageExists = await deps.inspectImage(input.image);
      if (!imageExists) {
        throw new Error('Sandbox image not found. Run `wake sandbox build` first.');
      }

      const containerState = await deps.inspectContainer(input.containerName);
      if (containerState === 'running') {
        return;
      }

      if (containerState === 'stopped') {
        await deps.run(['start', input.containerName]);
        return;
      }

      await deps.run(buildRunArgs(input));
    },

    async update(input: DockerUpInput): Promise<void> {
      const imageExists = await deps.inspectImage(input.image);
      if (!imageExists) {
        throw new Error('Sandbox image not found. Run `wake sandbox build` first.');
      }

      const containerState = await deps.inspectContainer(input.containerName);
      if (containerState === 'running' || containerState === 'stopped') {
        if (containerState === 'running') {
          await deps.run(['stop', input.containerName]);
        }

        await deps.run(['rm', input.containerName]);
      }

      await deps.run(buildRunArgs(input));
    },

    async down(containerName: string): Promise<void> {
      await deps.run(['stop', containerName]);
    },

    async setup(containerName: string): Promise<void> {
      await deps.run(['exec', '-it', containerName, 'bash', '/wake/docker/setup.sh']);
    },

    async exec(containerName: string, command: string[]): Promise<void> {
      await deps.run(
        command.length > 0
          ? ['exec', '-i', containerName, ...command]
          : ['exec', '-it', containerName, 'bash'],
      );
    },

    async execInteractive(containerName: string, command: string[]): Promise<void> {
      await deps.run(
        command.length > 0
          ? ['exec', '-it', containerName, ...command]
          : ['exec', '-it', containerName, 'bash'],
      );
    },

    async logs(containerName: string, tailLines: number): Promise<void> {
      await deps.run(['logs', '--tail', String(tailLines), containerName]);
    },
  };
}
