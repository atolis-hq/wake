/** Surface-local Docker process boundary; composition supplies the real invoker. */
export interface DockerCli {
  invoke(arguments_: readonly string[]): Promise<void>;
}

export function createDockerCli(invoke: DockerCli['invoke']): DockerCli {
  return { invoke };
}
