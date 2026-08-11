import { createInterface } from 'node:readline';

import { scrubSecrets } from '../../cli/sandbox-exec-logging.js';

export type DockerContainerState = 'running' | 'stopped' | null;

/**
 * Minimal shape of a spawned child process needed by `execCaptured` — just
 * enough of `child_process.ChildProcess` to read piped stdout/stderr and
 * learn how the process exited, so tests can fake it without a real spawn.
 */
export type DockerExecProcess = {
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'close', listener: (exitCode: number | null) => void): void;
};

export type DockerBuildInput = {
  image: string;
  dockerfile: string;
  contextDir: string;
  buildArgs?: Record<string, string>;
};

export type DockerUiInput = {
  enabled: boolean;
  port: number;
  token?: string | undefined;
  tunnel?:
    | {
        enabled: boolean;
        authToken?: string | undefined;
      }
    | undefined;
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

const DOCKER_LOG_MAX_SIZE = '10m';
const DOCKER_LOG_MAX_FILE = '3';

function buildRunArgs(input: DockerUpInput): string[] {
  return [
    'run',
    '-d',
    '--log-opt',
    `max-size=${DOCKER_LOG_MAX_SIZE}`,
    '--log-opt',
    `max-file=${DOCKER_LOG_MAX_FILE}`,
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
    // Auto-started by wake sandbox-entrypoint; the UI binds 0.0.0.0 inside the
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
                '-e',
                input.ui.tunnel.authToken !== undefined
                  ? `NGROK_AUTHTOKEN=${input.ui.tunnel.authToken}`
                  : 'NGROK_AUTHTOKEN',
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
  inspectContainerImage?(containerName: string): Promise<string | null>;
  spawnExec?(args: string[]): DockerExecProcess;
}) {
  return {
    async inspectContainerImage(containerName: string): Promise<string | null> {
      return (await deps.inspectContainerImage?.(containerName)) ?? null;
    },

    async build(input: DockerBuildInput): Promise<void> {
      const buildArgFlags = Object.entries(input.buildArgs ?? {}).flatMap(([key, value]) => [
        '--build-arg',
        `${key}=${value}`,
      ]);
      await deps.run([
        'build',
        '-t',
        input.image,
        '-f',
        input.dockerfile,
        ...buildArgFlags,
        input.contextDir,
      ]);
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

    /**
     * Runs `docker exec -i <containerName> <command>` with piped (not
     * inherited) stdio, line-buffers stdout/stderr, scrubs secrets from each
     * line, and forwards it to the caller's handlers in real time. Used by
     * `sandbox exec` so live output is observed and redacted on the host
     * instead of being wrapped by a mounted in-container script.
     */
    async execCaptured(
      containerName: string,
      command: string[],
      handlers: { onStdout: (line: string) => void; onStderr: (line: string) => void },
    ): Promise<void> {
      if (deps.spawnExec === undefined) {
        throw new Error('docker cli adapter was not configured with spawnExec');
      }

      const args = ['exec', '-i', containerName, ...command];
      const child = deps.spawnExec(args);

      const stdoutReader = createInterface({ input: child.stdout });
      stdoutReader.on('line', (line) => handlers.onStdout(scrubSecrets(line)));

      const stderrReader = createInterface({ input: child.stderr });
      stderrReader.on('line', (line) => handlers.onStderr(scrubSecrets(line)));

      await new Promise<void>((resolveExec, reject) => {
        child.on('error', reject);
        child.on('close', (exitCode) => {
          stdoutReader.close();
          stderrReader.close();

          if (exitCode === 0) {
            resolveExec();
            return;
          }

          reject(new Error(`docker ${args.join(' ')} failed with exit code ${exitCode ?? 1}`));
        });
      });
    },

    async logs(containerName: string, tailLines: number): Promise<void> {
      await deps.run(['logs', '--tail', String(tailLines), containerName]);
    },
  };
}
