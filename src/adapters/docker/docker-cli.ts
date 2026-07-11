export type DockerContainerState = 'running' | 'stopped' | null;

export type DockerBuildInput = {
  image: string;
  dockerfile: string;
  contextDir: string;
};

export type DockerUiInput = {
  enabled: boolean;
  port: number;
  token?: string | undefined;
  tunnel?: {
    enabled: boolean;
    authToken?: string | undefined;
  } | undefined;
};

export type DockerStartInput = {
  enabled: boolean;
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
  ui?: DockerUiInput | undefined;
  start?: DockerStartInput | undefined;
  stopTimeoutSeconds?: number;
};

export type DockerCli = ReturnType<typeof createDockerCli>;

function buildStopArgs(containerName: string, timeoutSeconds?: number): string[] {
  return [
    'stop',
    ...(timeoutSeconds !== undefined ? ['--time', String(timeoutSeconds)] : []),
    containerName,
  ];
}

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
    // Auto-started by docker/entrypoint.sh; the UI binds 0.0.0.0 inside the
    // container so this published port can reach it (127.0.0.1 inside the
    // container would not be reachable via docker's port-forwarding NAT).
    ...(input.ui?.enabled === true
      ? [
          '-p',
          `127.0.0.1:${input.ui.port}:${input.ui.port}`,
          '-e',
          'WAKE_UI_ENABLED=true',
          '-e',
          `WAKE_UI_PORT=${input.ui.port}`,
          ...(input.ui.token !== undefined ? ['-e', `WAKE_UI_TOKEN=${input.ui.token}`] : []),
          ...(input.ui.tunnel?.enabled === true
            ? [
                '-e',
                'WAKE_UI_TUNNEL_ENABLED=true',
                ...(input.ui.tunnel.authToken !== undefined
                  ? ['-e', `NGROK_AUTHTOKEN=${input.ui.tunnel.authToken}`]
                  : []),
              ]
            : []),
        ]
      : []),
    ...(input.start?.enabled === true ? ['-e', 'WAKE_START_ENABLED=true'] : []),
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
          await deps.run(buildStopArgs(input.containerName, input.stopTimeoutSeconds));
        }

        await deps.run(['rm', input.containerName]);
      }

      await deps.run(buildRunArgs(input));
    },

    async down(containerName: string, options?: { timeoutSeconds?: number }): Promise<void> {
      await deps.run(buildStopArgs(containerName, options?.timeoutSeconds));
    },

    async exec(
      containerName: string,
      command: string[],
      options?: { interactive?: boolean },
    ): Promise<void> {
      const interactive = options?.interactive ?? false;
      await deps.run(
        command.length > 0
          ? ['exec', interactive ? '-it' : '-i', containerName, ...command]
          : ['exec', '-it', containerName, 'bash'],
      );
    },

    async logs(containerName: string, tailLines: number): Promise<void> {
      await deps.run(['logs', '--tail', String(tailLines), containerName]);
    },
  };
}
