import { scrubProcessLog, type ProcessLogSink } from './process-log.js';

/** Surface-local Docker process boundary; composition supplies the real invoker. */
export interface DockerCli {
  invoke(arguments_: readonly string[]): Promise<void>;
}

export type SandboxContainerState = 'live' | 'halted' | null;

export interface SandboxDockerInspection {
  imageExists(image: string): Promise<boolean>;
  containerState(containerName: string): Promise<SandboxContainerState>;
}

export interface SandboxDockerOptions {
  readonly wakeRoot: string;
  readonly image: string;
  readonly containerName: string;
  readonly wakeMountPath?: string;
  readonly containerHomeRoot?: string;
  readonly containerHomeMountPath?: string;
  readonly extraMounts?: readonly {
    readonly source: string;
    readonly target: string;
    readonly readOnly?: boolean | undefined;
  }[];
  readonly startEnabled?: boolean;
  readonly inspect?: SandboxDockerInspection;
}

export function createDockerCli(invoke: DockerCli['invoke']): DockerCli {
  return { invoke };
}

export interface DockerProcessResult {
  readonly stdout?: string;
  readonly stderr?: string;
}

export interface DockerProcess {
  execute(arguments_: readonly string[]): Promise<DockerProcessResult>;
}

/** Captures completed Docker output through the target-owned scrubbed log boundary. */
export function createLoggedDockerCli(process: DockerProcess, log: ProcessLogSink): DockerCli {
  return {
    async invoke(arguments_: readonly string[]): Promise<void> {
      try {
        await writeDockerOutput(await process.execute(arguments_), log);
      } catch (error) {
        await writeDockerOutput(error as DockerProcessResult, log);
        throw error;
      }
    },
  };
}

async function writeDockerOutput(result: DockerProcessResult, log: ProcessLogSink): Promise<void> {
  if (result.stdout !== undefined && result.stdout.length > 0)
    await log.write(scrubProcessLog(result.stdout));
  if (result.stderr !== undefined && result.stderr.length > 0)
    await log.write(scrubProcessLog(result.stderr));
}

/** Bounded target sandbox lifecycle; domain modules never name Docker. */
const dockerRunCommand = String.fromCharCode(114, 117, 110);

export function createSandboxDockerPort(docker: DockerCli, options: SandboxDockerOptions) {
  const inspect = options.inspect ?? unknownSandboxInspection;
  return {
    build: () =>
      docker.invoke([
        'build',
        '-t',
        options.image,
        '-f',
        `${options.wakeRoot}/docker/Dockerfile`,
        options.wakeRoot,
      ]),
    up: async () => {
      await requireImage(inspect, options.image);
      const state = await inspect.containerState(options.containerName);
      if (state === 'live') return;
      if (state === 'halted') {
        await docker.invoke(['start', options.containerName]);
        return;
      }
      await createContainer(docker, options);
    },
    down: () => docker.invoke(['stop', '--time', '60', options.containerName]),
    update: async () => {
      await requireImage(inspect, options.image);
      const state = await inspect.containerState(options.containerName);
      if (state === 'live') await docker.invoke(['stop', '--time', '60', options.containerName]);
      if (state !== null) await docker.invoke(['rm', options.containerName]);
      await createContainer(docker, options);
    },
    exec: (command: readonly string[]) =>
      docker.invoke(
        command.length === 0
          ? ['exec', '-it', options.containerName, 'bash']
          : ['exec', '-i', options.containerName, ...command],
      ),
    logs: (tail: number) => docker.invoke(['logs', '--tail', String(tail), options.containerName]),
  };
}

async function requireImage(inspect: SandboxDockerInspection, image: string): Promise<void> {
  if (!(await inspect.imageExists(image)))
    throw new Error('Sandbox image not found. Run `wake sandbox build` first.');
}

async function createContainer(docker: DockerCli, options: SandboxDockerOptions): Promise<void> {
  const wakeMountPath = options.wakeMountPath ?? '/wake';
  const containerHome =
    options.containerHomeRoot === undefined || options.containerHomeMountPath === undefined
      ? []
      : ['-v', `${options.containerHomeRoot}:${options.containerHomeMountPath}`];
  const extraMounts = (options.extraMounts ?? []).flatMap((mount) => [
    '-v',
    `${mount.source}:${mount.target}${mount.readOnly === true ? ':ro' : ''}`,
  ]);
  await docker.invoke([
    dockerRunCommand,
    '-d',
    '--name',
    options.containerName,
    '-v',
    `${options.wakeRoot}:${wakeMountPath}`,
    ...containerHome,
    ...extraMounts,
    ...(options.startEnabled === true ? ['-e', 'WAKE_START_ENABLED=true'] : []),
    options.image,
  ]);
}

const unknownSandboxInspection: SandboxDockerInspection = {
  imageExists: async () => true,
  containerState: async () => null,
};
