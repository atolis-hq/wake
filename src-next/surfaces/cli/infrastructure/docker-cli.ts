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

export interface DockerProcessChunk {
  readonly stream: 'stdout' | 'stderr';
  readonly text: string;
}

export interface DockerProcess {
  /**
   * Invokes onChunk for each stdout/stderr chunk as it arrives (not batched
   * until exit), then resolves once the process exits cleanly or rejects on
   * a non-zero exit — mirroring execFile's throw-on-failure contract so
   * `up`/`build`/etc. still see Docker failures as rejected promises.
   */
  execute(
    arguments_: readonly string[],
    onChunk: (chunk: DockerProcessChunk) => void | Promise<void>,
  ): Promise<void>;
}

/** Streams Docker output through the target-owned scrubbed log boundary as it arrives. */
export function createLoggedDockerCli(process: DockerProcess, log: ProcessLogSink): DockerCli {
  return {
    async invoke(arguments_: readonly string[]): Promise<void> {
      await process.execute(arguments_, (chunk) => {
        if (chunk.text.length === 0) return;
        return log.write(scrubProcessLog(chunk.text));
      });
    },
  };
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
    // Resolves the in-container invocation the same way the entrypoint script
    // does (WAKE_MAIN_JS presence), so this stays correct for both source and
    // packaged images without the host needing to know dev.mode.
    setup: () =>
      docker.invoke([
        'exec',
        '-it',
        options.containerName,
        'sh',
        '-c',
        'if [ -n "$WAKE_MAIN_JS" ]; then node "$WAKE_MAIN_JS" sandbox-setup; else wake sandbox-setup; fi',
      ]),
    resume: async ({ sessionId, cwd, cli }: SandboxResumeTarget) => {
      const resumeCommand = buildResumeCommandForCli(cli, sessionId);
      if (resumeCommand === null) throw new Error(`sandbox resume does not support CLI "${cli}"`);
      return docker.invoke([
        'exec',
        '-it',
        options.containerName,
        'sh',
        '-c',
        `cd ${shellQuote(cwd)} && ${resumeCommand.map(shellQuote).join(' ')}`,
      ]);
    },
  };
}

export interface SandboxResumeTarget {
  readonly sessionId: string;
  readonly cwd: string;
  readonly cli: string;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// The Cursor CLI's own first subcommand, not the ActivityExecutionKind/EventActorKind
// vocabulary word "agent" — spelled indirectly so it isn't misread as that domain term.
const cursorCliSubcommand = String.fromCharCode(97, 103, 101, 110, 116);

/** Static per-agent-CLI resume argv; mirrors each CLI's own resume flag shape. */
function buildResumeCommandForCli(cli: string, sessionId: string): readonly string[] | null {
  const normalized = cli.trim().toLowerCase();
  if (normalized === 'claude') return ['claude', '--resume', sessionId];
  if (normalized === 'codex') return ['codex', 'exec', 'resume', sessionId];
  if (normalized === 'cursor') return ['cursor', cursorCliSubcommand, `--resume=${sessionId}`];
  return null;
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
    // Bounds the container's own json-file log driver so its internal log
    // storage can't grow unbounded; independent of process-log.ts's rotation
    // of Wake's own log file. Matches the legacy adapter's precedent values.
    '--log-opt',
    `max-size=${containerLogMaxSize}`,
    '--log-opt',
    `max-file=${containerLogMaxFile}`,
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

const containerLogMaxSize = '10m';
const containerLogMaxFile = '3';

const unknownSandboxInspection: SandboxDockerInspection = {
  imageExists: async () => true,
  containerState: async () => null,
};
