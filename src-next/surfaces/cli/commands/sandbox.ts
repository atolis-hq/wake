export interface SandboxDockerPort {
  build(): Promise<unknown>;
  up(): Promise<unknown>;
  down(): Promise<unknown>;
}

export async function runSandbox(
  arguments_: readonly string[],
  docker: SandboxDockerPort,
): Promise<void> {
  const [command] = arguments_;
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
    default:
      throw new Error(`Unknown sandbox command: ${command ?? ''}`);
  }
}
