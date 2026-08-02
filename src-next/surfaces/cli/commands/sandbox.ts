export interface SandboxDockerPort {
  build(): Promise<unknown>;
  up(): Promise<unknown>;
  down(): Promise<unknown>;
  update?(): Promise<unknown>;
  exec?(command: readonly string[]): Promise<unknown>;
  logs?(tail: number): Promise<unknown>;
  setup?(): Promise<unknown>;
  resume?(target: { sessionId: string; cwd: string; cli: string }): Promise<unknown>;
}

export async function runSandbox(
  arguments_: readonly string[],
  docker: SandboxDockerPort,
): Promise<void> {
  const [command, ...rest] = arguments_;
  switch (command) {
    case 'build':
      await docker.build();
      return;
    case 'up':
      await docker.up();
      return;
    case 'down':
      await docker.down();
      return;
    case 'update':
      await runUpdate(docker);
      return;
    case 'exec':
      await runExec(docker, rest);
      return;
    case 'logs':
      await runLogs(docker, rest);
      return;
    case 'setup':
      await runSetup(docker);
      return;
    case 'resume':
      await runResume(docker, rest);
      return;
    default:
      throw new Error(`Unknown sandbox command: ${command ?? ''}`);
  }
}

async function runUpdate(docker: SandboxDockerPort): Promise<void> {
  if (docker.update === undefined) throw new Error('sandbox update is not configured');
  await docker.update();
}

async function runExec(docker: SandboxDockerPort, rest: readonly string[]): Promise<void> {
  const forwarded = rest[0] === '--' ? rest.slice(1) : rest;
  if (docker.exec === undefined) throw new Error('sandbox exec is not configured');
  await docker.exec(forwarded);
}

async function runLogs(docker: SandboxDockerPort, rest: readonly string[]): Promise<void> {
  if (docker.logs === undefined) throw new Error('sandbox logs are not configured');
  await docker.logs(readTail(rest));
}

async function runSetup(docker: SandboxDockerPort): Promise<void> {
  if (docker.setup === undefined) throw new Error('sandbox setup is not configured');
  await docker.setup();
}

async function runResume(docker: SandboxDockerPort, rest: readonly string[]): Promise<void> {
  if (docker.resume === undefined) throw new Error('sandbox resume is not configured');
  await docker.resume(readResumeTarget(rest));
}

/**
 * Only the explicit-args resume path is ported: `<sessionId> --cwd <path>
 * --cli <claude|codex|cursor>`. Legacy's zero-arg path additionally listed
 * past sessions from a flat run-record file and prompted an interactive
 * pick; the target has no equivalent surfaced to the CLI/Docker layer (run
 * history lives behind the composition root's event-sourced Execution
 * projection, and building an interactive picker over it is a distinct,
 * larger feature than this Docker-boundary port). Attended resume is also
 * now less central architecturally: `RunnerRequest.resumeSessionId` already
 * lets the control plane resume a session as part of normal run dispatch
 * (see src-next/execution/contracts/runner.ts), so this command remains
 * useful only as a manual attach-and-resume for debugging.
 */
function readResumeTarget(arguments_: readonly string[]): {
  sessionId: string;
  cwd: string;
  cli: string;
} {
  const sessionId = arguments_[0];
  if (sessionId === undefined || sessionId.startsWith('--'))
    throw new Error('sandbox resume requires a session id');
  const cwd = readOption(arguments_, '--cwd');
  if (cwd === undefined) throw new Error('sandbox resume requires --cwd <path>');
  const cli = readOption(arguments_, '--cli');
  if (cli === undefined) throw new Error('sandbox resume requires --cli <claude|codex|cursor>');
  return { sessionId, cwd, cli };
}

function readOption(arguments_: readonly string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  return index === -1 ? undefined : arguments_[index + 1];
}

function readTail(arguments_: readonly string[]): number {
  if (arguments_.length === 0) return 200;
  if (arguments_.length !== 2 || arguments_[0] !== '--tail')
    throw new Error('sandbox logs accepts only --tail <positive integer>');
  const tail = Number(arguments_[1]);
  if (!Number.isInteger(tail) || tail <= 0) throw new Error('sandbox logs tail must be positive');
  return tail;
}
