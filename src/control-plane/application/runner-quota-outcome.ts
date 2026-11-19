import {
  ActivityFailureCode,
  ActivityOutcomeKind,
  RunnerAuthenticationMessage,
  type ActivityOutcome,
} from '../../activities/index.js';

// Authentication uses the existing durable infrastructure retry protocol, whose event retains its quota name.
export function isRunnerUnavailableOutcome(outcome: ActivityOutcome): boolean {
  return (
    (outcome.kind === ActivityOutcomeKind.Failed || outcome.kind === ActivityOutcomeKind.Blocked) &&
    typeof outcome.data === 'object' &&
    outcome.data !== null &&
    'reason' in outcome.data &&
    ((outcome.data as { reason?: unknown }).reason === ActivityFailureCode.RunnerQuotaExceeded ||
      (outcome.data as { reason?: unknown }).reason ===
        ActivityFailureCode.RunnerAuthenticationRequired)
  );
}

export function runnerUnavailableMessage(outcome: ActivityOutcome): string {
  const data = outcome.data as { message?: unknown; reason?: unknown };
  if (data.reason === ActivityFailureCode.RunnerAuthenticationRequired)
    return RunnerAuthenticationMessage;
  return typeof data.message === 'string' ? data.message : 'runner reported quota exhaustion';
}

/**
 * A quota retry deliberately leaves the outcome unaccepted, so a port that
 * never applied it (absent method, or a workflow instance that vanished)
 * leaves the Run permanently unresolved. Surface that rather than going
 * silent; it is an operational defect, not a workflow state.
 */
export function reportUnappliedRunnerQuotaRetry(
  result: unknown,
  input: { readonly activationId: string; readonly runId: string },
): void {
  if (result !== null && result !== undefined) return;
  console.error(
    `Runner-quota retry was not applied for activation ${input.activationId} (run ${input.runId}); its outcome remains unaccepted.`,
  );
}
