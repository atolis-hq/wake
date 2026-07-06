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
};

export type DockerCli = ReturnType<typeof createDockerCli>;

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

      await deps.run([
        'run',
        '-d',
        '--name',
        input.containerName,
        '-v',
        `${input.wakeRoot}:${input.containerMountPath}`,
        '-v',
        `${input.containerHomeRoot}:${input.containerHomeMountPath}`,
        input.image,
      ]);
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
  };
}
