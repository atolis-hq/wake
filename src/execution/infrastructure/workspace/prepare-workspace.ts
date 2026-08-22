import type { ExecutionConfig } from '../../contracts/config.js';
import { runProcess, type ProcessExecutionResult } from '../process-execution.js';

export type WorkspacePrepareHook = NonNullable<ExecutionConfig['workspaceHooks']>['prepare'];

const prepareOutputTailBytes = 4096;

export async function prepareWorkspace(
  path: string,
  hook: NonNullable<WorkspacePrepareHook>,
): Promise<void> {
  const process = runProcess(
    hook.command,
    [],
    path,
    new AbortController().signal,
    { hardMs: hook.timeoutMs },
    true,
  );
  const result = await process.result;
  if (result.exitCode === 0 && !result.timedOut && result.failureKind === undefined) return;
  throw new Error(prepareFailureMessage(hook.command, result));
}

function prepareFailureMessage(command: string, result: ProcessExecutionResult): string {
  const reason = result.timedOut
    ? 'timed out'
    : (result.failureMessage ?? `exited with code ${result.exitCode ?? 'unavailable'}`);
  const output = result.combinedOutput.subarray(-prepareOutputTailBytes).toString('utf8');
  return `Workspace prepare hook (${command}) ${reason}. Combined output tail (last ${prepareOutputTailBytes} bytes):\n${output}`;
}
