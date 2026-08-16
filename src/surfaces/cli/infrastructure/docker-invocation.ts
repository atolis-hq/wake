export interface DockerInvokeOptions {
  readonly interactive?: boolean;
  /** Captures output for the caller without forwarding chunks to the normal process log. */
  readonly suppressOutput?: boolean;
}

export interface DockerInvocationResult {
  readonly stdout: string;
  readonly stderr: string;
}

/** A failed Docker invocation whose streamed output remains available for a concise caller diagnostic. */
export class DockerProcessError extends Error {
  constructor(
    message: string,
    readonly result: DockerInvocationResult,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'DockerProcessError';
  }
}
