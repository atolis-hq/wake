import {
  RunStatus,
  type AgentRunnerResult,
  type Runner,
  type RunnerRequest,
} from '../../src/execution/index.js';

/** Permanent zero-token runner for delegation actions during a real Execution Run. */
export class ScriptedDelegationRunner implements Runner {
  readonly name = 'fake';
  readonly supportsEphemeralMcp = true;
  readonly scripts: ((request: RunnerRequest) => Promise<AgentRunnerResult>)[] = [];
  scriptFor:
    | ((
        request: RunnerRequest,
      ) => ((request: RunnerRequest) => Promise<AgentRunnerResult>) | undefined)
    | undefined;

  readonly requests: RunnerRequest[] = [];

  async start(request: RunnerRequest) {
    this.requests.push(request);
    const script = this.scriptFor?.(request) ?? this.scripts.shift();
    return {
      result:
        script === undefined
          ? Promise.resolve({
              transport: RunStatus.Succeeded,
              runner: this.name,
              output: '{"status":"DONE"}',
            })
          : script(request),
      async cancel() {},
    };
  }
}
