export interface ResidentSupervisorDependencies {
  readonly restartDelaySeconds: number;
  readonly wakeInvocation: readonly string[];
  readonly pidFile: string;
  readonly startLogFile: string;
  readonly spawnDetached: (
    command: string,
    arguments_: readonly string[],
    options: { readonly logFile: string },
  ) => { readonly pid: number };
  readonly waitForExit: (pid: number) => Promise<number>;
  readonly writeFile: (path: string, content: string) => Promise<void>;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly log: (message: string) => void;
}

export interface SandboxEntrypointDependencies extends ResidentSupervisorDependencies {
  readonly startEnabled: boolean;
  readonly ensureLogDirectory: () => Promise<void>;
  readonly waitForever: () => Promise<never>;
}

/**
 * Never resolves, and never lets the process exit either. The supervised
 * child is spawned detached and unref'd (see spawnDetached), so an
 * unresolved Promise alone is not enough here — a Promise executor registers
 * no libuv handle, and once other pending I/O quiets down Node treats the
 * still-pending top-level await as unsettled and exits anyway. A ref'd
 * timer is a real handle, so it keeps the process alive for as long as this
 * Promise is meant to.
 */
export function waitForever(): Promise<never> {
  return new Promise<never>(() => {
    setInterval(() => {}, 1 << 30);
  });
}

/**
 * Restarts `wake start` on every exit — a first-boot crash (e.g. missing
 * sandbox auth) must not stop the retry loop, since the operator's only path
 * to fixing it (`wake sandbox setup`) also depends on this loop's container
 * staying alive.
 */
export async function runResidentSupervisor(deps: ResidentSupervisorDependencies): Promise<never> {
  const [command, ...prefix] = deps.wakeInvocation;
  if (command === undefined) throw new Error('sandbox entrypoint requires a wake invocation');
  for (;;) {
    deps.log('wake start: starting resident loop');
    const { pid } = deps.spawnDetached(
      command,
      [...prefix, 'start', '--wake-root', '/wake', '--no-sandbox'],
      { logFile: deps.startLogFile },
    );
    await deps.writeFile(deps.pidFile, String(pid));
    const exitCode = await deps.waitForExit(pid);
    deps.log(
      `wake start: resident loop exited with status ${exitCode}; restarting in ${deps.restartDelaySeconds}s`,
    );
    await deps.sleep(deps.restartDelaySeconds * 1000);
  }
}

/**
 * Keeps the sandbox container alive regardless of whether `wake start` can
 * currently run — `sandbox setup`/`sandbox exec` need a live container to
 * reach into, including on first boot before auth is configured.
 */
export async function runSandboxEntrypoint(deps: SandboxEntrypointDependencies): Promise<void> {
  await deps.ensureLogDirectory();
  if (deps.startEnabled) {
    void runResidentSupervisor(deps).catch((error) => {
      deps.log(
        `wake start: supervisor stopped unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }
  await deps.waitForever();
}
