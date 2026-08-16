import { expect, it } from 'vitest';
import type { CompositionRoot } from '../../../src/bootstrap/composition-root.js';
import { createExecutionApplications } from '../../../src/bootstrap/surface-api-execution-applications.js';

it('records an operator-declared failed resolution and makes its workflow retryable', async () => {
  const calls: string[] = [];
  const applications = createExecutionApplications(
    {
      execution: {
        list: async () => [{ runId: 'run-ambiguous', status: 'ambiguous', escalated: true }],
      },
      recovery: {
        resolve: async (
          runId: string,
          resolution: { readonly kind: string },
          context: { readonly actor: { readonly kind: string } },
        ) => {
          calls.push(`resolve:${runId}:${resolution.kind}:${context.actor.kind}`);
          return {
            runId,
            status: 'failed',
            activationId: 'activation-1',
            workflowInstanceId: 'workflow-1',
            orchestrationGroupId: 'group-1',
          };
        },
      },
      orchestration: {
        resolveExecutionFailure: async (
          workflowInstanceId: string,
          input: { readonly activationId: string; readonly runId: string; readonly reason: string },
        ) => {
          calls.push(
            `block:${workflowInstanceId}:${input.activationId}:${input.runId}:${input.reason}`,
          );
        },
      },
    } as unknown as CompositionRoot,
    () => '2026-08-16T13:00:00.000Z',
  );
  const resolve = applications.resolveAmbiguousRun;
  if (resolve === undefined) throw new Error('Expected ambiguous Run resolution application');

  await expect(
    resolve('run-ambiguous', {
      idempotencyKey: 'operator-1',
      message: 'The external process cannot be verified.',
    }),
  ).resolves.toMatchObject({ idempotencyKey: 'operator-1', status: 'completed' });
  expect(calls).toEqual([
    'resolve:run-ambiguous:failed:operator',
    'block:workflow-1:activation-1:run-ambiguous:The external process cannot be verified.',
  ]);
});
