import {
  DockerProcessError,
  type DockerInvocationResult,
  type DockerInvokeOptions,
} from './docker-invocation.js';

interface ResidentStartDocker {
  invoke(
    arguments_: readonly string[],
    options: Pick<DockerInvokeOptions, 'suppressOutput'>,
  ): Promise<DockerInvocationResult>;
}

/** Verifies the replacement sandbox has started its resident Wake process. */
export async function verifyResidentStart(
  docker: ResidentStartDocker,
  containerName: string,
  expectedCmdlineFragment: string,
  options?: { readonly attempts?: number; readonly intervalMs?: number },
): Promise<void> {
  const attempts = options?.attempts ?? 15;
  const intervalMs = options?.intervalMs ?? 1000;
  const check = [
    'pid="$(cat /wake/.wake/logs/start.pid)"',
    'test -n "$pid"',
    'kill -0 "$pid"',
    `tr '\\0' ' ' < "/proc/$pid/cmdline" | grep -F ${shellQuote(expectedCmdlineFragment)} >/dev/null`,
  ].join(' && ');
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await docker.invoke(['exec', '-i', containerName, 'sh', '-lc', check], {
        suppressOutput: attempt < attempts,
      });
      return;
    } catch (error) {
      if (attempt === attempts) throw residentStartFailure(attempts, error);
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}

function residentStartFailure(attempts: number, error: unknown): Error {
  const detail =
    error instanceof DockerProcessError
      ? [
          error.message,
          error.result.stdout.length === 0 ? '' : `stdout: ${error.result.stdout.trim()}`,
          error.result.stderr.length === 0 ? '' : `stderr: ${error.result.stderr.trim()}`,
        ]
          .filter((value) => value.length > 0)
          .join('; ')
      : error instanceof Error
        ? error.message
        : String(error);
  return new Error(
    `Wake resident start did not become healthy after ${String(attempts)} attempts: ${detail}`,
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
