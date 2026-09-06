interface RootDockerExecutor {
  invoke(arguments_: readonly string[]): Promise<unknown>;
}

interface WorkspaceSandbox {
  readonly containerName: string;
  readonly wakeMountPath?: string;
}

/** Ensures the bind-mounted workspace root is usable by the unprivileged sandbox process. */
export async function ensureSandboxWorkspaceOwnership(
  docker: RootDockerExecutor,
  options: WorkspaceSandbox,
): Promise<void> {
  await docker.invoke([
    'exec',
    '-u',
    'root',
    options.containerName,
    'sh',
    '-c',
    'mkdir -p "$1" && chown wake:wake "$1"',
    'wake-workspace-ownership',
    `${options.wakeMountPath ?? '/wake'}/workspaces`,
  ]);
}
