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
      status: 'failed',
      reason: 'The external process cannot be verified.',
    }),
  ).resolves.toMatchObject({ idempotencyKey: 'operator-1', status: 'completed' });
  expect(calls).toEqual([
    'resolve:run-ambiguous:failed:operator',
    'block:workflow-1:activation-1:run-ambiguous:The external process cannot be verified.',
  ]);
});

it('accepts a validated operator-declared success into its workflow', async () => {
  const calls: string[] = [];
  const applications = createExecutionApplications(
    {
      recovery: {
        resolve: async (_runId: string, resolution: { readonly kind: string }) => {
          calls.push(`resolve:${resolution.kind}`);
          return {
            runId: 'run-ambiguous',
            status: 'succeeded',
            activationId: 'activation-1',
            workflowInstanceId: 'workflow-1',
            orchestrationGroupId: 'group-1',
            outcome: { kind: 'done' },
          };
        },
      },
      orchestration: {
        acceptOutcome: async (input: {
          readonly workflowInstanceId: string;
          readonly outcome: { readonly kind: string };
        }) => {
          calls.push(`accept:${input.workflowInstanceId}:${input.outcome.kind}`);
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
      status: 'succeeded',
      outcome: { kind: 'done' },
    }),
  ).resolves.toMatchObject({ idempotencyKey: 'operator-1', status: 'completed' });
  expect(calls).toEqual(['resolve:succeeded', 'accept:workflow-1:done']);
});
