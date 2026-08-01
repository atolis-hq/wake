import { RetrySafety } from '../../../activities/index.js';
import type { Runner, RunnerExecution, RunnerRequest } from '../../contracts/runner.js';
import { RunStatus } from '../../contracts/vocabulary.js';

export class FakeExecutionRunner implements Runner {
  readonly name = 'fake';

  async start(request: RunnerRequest, _signal: AbortSignal): Promise<RunnerExecution> {
    const status = request.prompt.includes('[fake:failed]')
      ? 'FAILED'
      : request.prompt.includes('[fake:blocked]')
        ? 'BLOCKED'
        : 'DONE';
    return {
      result: Promise.resolve({
        transport: RunStatus.Succeeded,
        output: JSON.stringify(
          status === 'FAILED' ? { status, retrySafety: RetrySafety.SafeToRetry } : { status },
        ),
        runner: this.name,
      }),
      async cancel() {},
    };
  }
}
