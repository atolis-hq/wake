import { describe, expect, it } from 'vitest';
import { WorkflowStatus } from '../../../orchestration/index.js';
import { WorkStatus } from '../../../work/index.js';
import { WakeApiClient } from '../src/api/client.js';
import { decodeWorkflow } from '../src/api/decoders.js';

describe('typed Wake API client', () => {
  it('groups requests by domain and decodes resource envelopes', async () => {
    const requests: string[] = [];
    const client = new WakeApiClient(async (input) => {
      requests.push(String(input));
      return new Response(
        JSON.stringify({
          data: { paused: false, updatedAt: '2026-07-31T10:00:00.000Z' },
          meta: { asOf: '2026-07-31T10:00:00.000Z' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    expect((await client.controlPlane.status()).data.paused).toBe(false);
    expect(requests).toEqual(['/api/v1/control-plane/status']);
  });

  it('decodes Problem Details without parsing detail text', async () => {
    const client = new WakeApiClient(
      async () =>
        new Response(
          JSON.stringify({
            type: 'https://wake.atolis.dev/problems/conflict',
            title: 'Conflict',
            status: 409,
            code: 'current-state',
            current: { paused: true },
          }),
          { status: 409, headers: { 'content-type': 'application/problem+json' } },
        ),
    );

    await expect(client.controlPlane.tick('command-1')).rejects.toMatchObject({
      problem: { status: 409, code: 'current-state', current: { paused: true } },
    });
  });

  it('invokes the fetch transport without binding it to the API client instance', async () => {
    let calledUnbound = false;
    const transport = function (this: unknown) {
      if (this !== undefined) throw new Error('Fetch transport was invoked with a receiver');
      calledUnbound = true;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: { paused: false, updatedAt: '2026-07-31T10:00:00.000Z' },
            meta: { asOf: '2026-07-31T10:00:00.000Z' },
          }),
        ),
      );
    } as typeof fetch;
    await new WakeApiClient(transport).controlPlane.status();
    expect(calledUnbound).toBe(true);
  });

  it('rejects a success envelope whose nested DTO does not match the transport contract', async () => {
    const client = new WakeApiClient(
      async () =>
        new Response(
          JSON.stringify({
            items: [
              {
                workItemKey: 'wk_demo',
                workItemId: 'work-demo',
                objective: 42,
                state: WorkStatus.Open,
                relatedWorkItems: [],
              },
            ],
            page: { nextCursor: null, hasMore: false },
            meta: { asOf: '2026-07-31T10:00:00.000Z' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );

    await expect(client.work.list()).rejects.toThrow(
      'Invalid Wake API response at items[0].objective',
    );
  });

  it('decodes the optional workflow retry eligibility capability', () => {
    expect(
      decodeWorkflow({
        workflowInstanceId: 'workflow-1',
        workItemKey: 'wk_demo',
        workflowName: 'default',
        orchestrationGroupId: 'group-1',
        status: WorkflowStatus.Blocked,
        currentStage: 'implement',
        retryEligible: true,
      }),
    ).toMatchObject({ retryEligible: true });
  });

  it('decodes the blocked workflow reason used to identify ambiguous-run recovery', () => {
    expect(
      decodeWorkflow({
        workflowInstanceId: 'workflow-1',
        workItemKey: 'wk_demo',
        workflowName: 'default',
        orchestrationGroupId: 'group-1',
        status: WorkflowStatus.Blocked,
        currentStage: 'implement',
        blockReason: 'run-ambiguous-after-3-attempts',
      }),
    ).toMatchObject({ blockReason: 'run-ambiguous-after-3-attempts' });
  });
});
