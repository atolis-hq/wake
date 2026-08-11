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
    const scenario =
      request.context === undefined
        ? undefined
        : this.scenarios.resolve({
            runner: request.context.runnerName,
            action: request.context.action,
            occurrence: request.context.activationOrdinal,
          });
    return {
      result: waitFor(scenario?.delayMs ?? 0, signal).then(() =>
        resultFor(this.name, scenario, request),
      ),
      async cancel() {},
    };
  }
}

function resultFor(
  name: string,
  scenario: ResolvedFakeScenario | undefined,
  request: RunnerRequest,
) {
  return {
    transport: RunStatus.Succeeded,
    output: JSON.stringify(outputFor(scenario, request.prompt)),
    runner: name,
  };
}

function outputFor(scenario: ResolvedFakeScenario | undefined, prompt: string) {
  const status = statusFor(scenario, prompt);
  return {
    status,
    ...retrySafetyFor(scenario, status),
    ...(scenario?.displayBody === undefined ? {} : { displayBody: scenario.displayBody }),
    ...(scenario?.reportedArtifacts === undefined
      ? {}
      : { reportedArtifacts: scenario.reportedArtifacts }),
  };
}

function statusFor(scenario: ResolvedFakeScenario | undefined, prompt: string) {
  if (scenario !== undefined) return scenario.outcome;
  if (prompt.includes('[fake:failed]')) return 'FAILED';
  return prompt.includes('[fake:blocked]') ? 'BLOCKED' : 'DONE';
}

function retrySafetyFor(scenario: ResolvedFakeScenario | undefined, status: string) {
  if (scenario?.retrySafety !== undefined) return { retrySafety: scenario.retrySafety };
  return status === 'FAILED' ? { retrySafety: RetrySafety.SafeToRetry } : {};
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
