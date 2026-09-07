import { DockerProcessError, type DockerCli } from './docker-cli.js';
import { scrubProcessLog } from './process-log.js';

/**
 * Adds the short-lived replacement container's logs to a rollout failure
 * before rollback removes that container. Docker otherwise reports only the
 * follow-on `exec` failure, which hides the actual entrypoint error.
 */
export async function describeSandboxStartupFailure(
  docker: DockerCli,
  containerName: string,
  error: unknown,
): Promise<Error> {
  const failure = formatDockerError(error);
  try {
    const output = await docker.invoke(['logs', '--tail', '100', containerName], {
      suppressOutput: true,
    });
    const logs = scrubProcessLog(`${output.stdout}${output.stderr}`).trim();
    if (logs.length > 0)
      return new Error(
        `Sandbox replacement "${containerName}" failed during startup: ${failure}\n` +
          `Container logs:\n${logs}`,
        { cause: error },
      );
  } catch (logsError) {
    return new Error(
      `Sandbox replacement "${containerName}" failed during startup: ${failure}. ` +
        `Could not collect its logs: ${formatDockerError(logsError)}`,
      { cause: error },
    );
  }
  return new Error(`Sandbox replacement "${containerName}" failed during startup: ${failure}`, {
    cause: error,
  });
}

function formatDockerError(error: unknown): string {
  if (error instanceof DockerProcessError) {
    const output = `${error.result.stdout}${error.result.stderr}`.trim();
    return output.length === 0 ? error.message : `${error.message}: ${scrubProcessLog(output)}`;
  }
  return error instanceof Error ? error.message : String(error);
}
