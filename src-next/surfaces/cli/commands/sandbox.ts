export interface SandboxDockerPort {
  build(): Promise<unknown>;
  up(): Promise<unknown>;
  down(): Promise<unknown>;
  update?(): Promise<unknown>;
  exec?(command: readonly string[]): Promise<unknown>;
  logs?(tail: number): Promise<unknown>;
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
      if (docker.update === undefined) throw new Error('sandbox update is not configured');
      await docker.update();
      return;
    case 'exec': {
      const forwarded = rest[0] === '--' ? rest.slice(1) : rest;
      if (docker.exec === undefined) throw new Error('sandbox exec is not configured');
      await docker.exec(forwarded);
      return;
    }
    case 'logs':
      if (docker.logs === undefined) throw new Error('sandbox logs are not configured');
      await docker.logs(readTail(rest));
      return;
    default:
      throw new Error(`Unknown sandbox command: ${command ?? ''}`);
  }
}

function readTail(arguments_: readonly string[]): number {
  if (arguments_.length === 0) return 200;
  if (arguments_.length !== 2 || arguments_[0] !== '--tail')
    throw new Error('sandbox logs accepts only --tail <positive integer>');
  const tail = Number(arguments_[1]);
  if (!Number.isInteger(tail) || tail <= 0) throw new Error('sandbox logs tail must be positive');
  return tail;
}
