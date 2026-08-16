import { OperatorRetryIneligibleError } from '../../../orchestration/index.js';

export async function ignoreIneligibleOperatorRetry(retry: () => Promise<unknown>): Promise<void> {
  try {
    await retry();
  } catch (error) {
    if (error instanceof OperatorRetryIneligibleError) return;
    throw error;
  }
}
