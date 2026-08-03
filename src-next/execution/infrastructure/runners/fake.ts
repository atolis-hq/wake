import { RetrySafety } from '../../../activities/index.js';
import type { Runner, RunnerExecution, RunnerRequest } from '../../contracts/runner.js';
import { RunStatus } from '../../contracts/vocabulary.js';
import {
  emptyFakeScenarios,
  type FakeScenarioResolver,
  type ResolvedFakeScenario,
} from './fake-scenarios.js';

export class FakeExecutionRunner implements Runner {
  constructor(
    readonly name = 'fake',
    private readonly scenarios: FakeScenarioResolver = emptyFakeScenarios,
  ) {}

  async start(request: RunnerRequest, signal: AbortSignal): Promise<RunnerExecution> {
    const scenario = request.simulation === undefined ? undefined : this.scenarios.resolve(request.simulation);
    return {
      result: waitFor(scenario?.delayMs ?? 0, signal).then(() => resultFor(this.name, scenario, request)),
      async cancel() {},
    };
  }
}

function resultFor(name: string, scenario: ResolvedFakeScenario | undefined, request: RunnerRequest) {
  const status =
    scenario?.outcome ??
    (request.prompt.includes('[fake:failed]')
      ? 'FAILED'
      : request.prompt.includes('[fake:blocked]')
        ? 'BLOCKED'
        : 'DONE');
  return {
    transport: RunStatus.Succeeded,
    output: JSON.stringify({
      status,
      ...(scenario?.retrySafety === undefined && status === 'FAILED'
        ? { retrySafety: RetrySafety.SafeToRetry }
        : scenario?.retrySafety === undefined
          ? {}
          : { retrySafety: scenario.retrySafety }),
      ...(scenario?.displayBody === undefined ? {} : { displayBody: scenario.displayBody }),
    }),
    runner: name,
  };
}

function waitFor(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('Fake runner execution aborted'));
      },
      { once: true },
    );
  });
}
