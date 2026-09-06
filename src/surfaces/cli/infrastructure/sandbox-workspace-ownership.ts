interface RootDockerExecutor {
  invoke(arguments_: readonly string[]): Promise<unknown>;
}

interface WorkspaceSandbox {
  readonly containerName: string;
  readonly wakeMountPath?: string;
}

/** Ensures the bind-mounted workspace and auth roots are usable by the sandbox process. */
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
    'mkdir -p "$1" "$2" && chown wake:wake "$1" "$2" && find "$2" -mindepth 1 -maxdepth 1 -type f -exec chown wake:wake {} +',
    'wake-sandbox-runtime-ownership',
    `${options.wakeMountPath ?? '/wake'}/workspaces`,
    `${options.wakeMountPath ?? '/wake'}/.wake/auth`,
  ]);
}
