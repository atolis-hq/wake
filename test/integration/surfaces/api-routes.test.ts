import { describe, expect, it } from 'vitest';
import type {
  AcceptedCommandResponse,
  ApiCommandResult,
  AuditEventResponse,
  RunTranscriptResponse,
  TickCommandResponse,
  WorkItemResponse,
  WorkItemTranscriptResponse,
} from '../../../src/surfaces/api/contracts/index.js';
import type {
  ApiApplications,
  ApiCollectionPage,
  ApiResourceResult,
  CollectionQuery,
} from '../../../src/surfaces/api/routes/index.js';
import { createApiDispatcher } from '../../../src/surfaces/api/routes/index.js';

describe('API domain routes', () => {
  it('reads a work item transcript group without exposing storage details', async () => {
    const key = 'wk_d29yay1kZW1v';
    const dispatcher = createApiDispatcher(
      applications({
        work: {
          transcript: async (receivedKey, groupId) => {
            expect(receivedKey).toBe(key);
            expect(groupId).toBe('session--codex--opaque-group');
            return resource({
              groupId,
              available: true,
              entries: [
                {
                  occurredAt: '2026-07-31T10:00:00.000Z',
                  channel: 'input',
                  text: 'Investigate the failure',
                  runId: 'run-1',
                  groupId,
                  durationMs: 1_000,
                },
              ],
            });
          },
        },
      }),
    );

    const response = await dispatcher.dispatch(
      'GET',
      `/api/v1/work-items/${key}/transcripts/session--codex--opaque-group`,
      undefined,
    );

    expect(response?.status).toBe(200);
    const encoded = JSON.stringify(response?.body);
    expect(encoded).not.toContain('C:\\private');
    expect(encoded).not.toContain('provider-session');
  });

  it('retains the run transcript deep link by resolving its containing group', async () => {
    const dispatcher = createApiDispatcher(
      applications({
        execution: {
          transcript: async (runId) =>
            resource({
              runId,
              groupId: 'run--opaque-group',
              available: true,
              entries: [
                {
                  occurredAt: '2026-07-31T10:00:00.000Z',
                  channel: 'agent',
                  text: 'DONE',
                  runId,
                  groupId: 'run--opaque-group',
                },
              ],
            }),
        },
      }),
    );

    expect(
      (await dispatcher.dispatch('GET', '/api/v1/runs/run-1/transcript', undefined))?.body,
    ).toMatchObject({
      data: { groupId: 'run--opaque-group', entries: [{ runId: 'run-1' }] },
    });
  });

  it('keeps missing transcript artifacts unavailable rather than reconstructing them', async () => {
    const dispatcher = createApiDispatcher(
      applications({
        execution: {
          transcript: async (runId) => resource({ runId, available: false, entries: [] }),
        },
      }),
    );

    expect(
      (await dispatcher.dispatch('GET', '/api/v1/runs/run-1/transcript', undefined))?.body,
    ).toMatchObject({
      data: { available: false, entries: [] },
    });
  });

  it('keeps an expired work-item transcript group unavailable instead of returning a 404', async () => {
    const dispatcher = createApiDispatcher(
      applications({
        work: {
          transcript: async (_key, groupId) => resource({ groupId, available: false, entries: [] }),
        },
      }),
    );

    const response = await dispatcher.dispatch(
      'GET',
      '/api/v1/work-items/wk_d29yay1kZW1v/transcripts/run--expired',
      undefined,
    );

    expect(response?.status).toBe(200);
    expect(response?.body).toMatchObject({ data: { available: false, entries: [] } });
  });

  it('uses the newest contributing sample for resource metadata instead of serialization time', async () => {
    const dispatcher = createApiDispatcher({
      ...applications(),
      now: () => '2026-07-31T11:00:00.000Z',
      controlPlane: {
        status: async () => resource({ paused: false, updatedAt: '2026-07-31T10:00:00.000Z' }),
      },
    });

    const response = await dispatcher.dispatch('GET', '/api/v1/control-plane/status', undefined);

    expect(response?.body).toMatchObject({
      data: { updatedAt: '2026-07-31T10:00:00.000Z' },
      meta: { asOf: '2026-07-31T10:00:00.000Z' },
    });
  });

  it('groups read operations by domain and returns RFC9457 problem details for an unknown route', async () => {
    const dispatcher = createApiDispatcher(applications());
    expect(
      (await dispatcher.dispatch('GET', '/api/v1/control-plane/status', undefined))?.status,
    ).toBe(200);
    const unknown = await dispatcher.dispatch('GET', '/api/v1/board', undefined);
    expect(unknown?.contentType).toBe('application/problem+json');
  });

  it('leaves browser routes to the asset host while retaining API 404 problems', async () => {
    const dispatcher = createApiDispatcher(applications());

    expect(await dispatcher.dispatch('GET', '/board', undefined)).toBeUndefined();
    expect((await dispatcher.dispatch('GET', '/api/v1/missing', undefined))?.status).toBe(404);
  });

  it.each(['freeze', 'unfreeze', 'delete', 'retry'] as const)(
    'delegates the work %s command with a stable idempotency key',
    async (name) => {
      const calls: Array<{ name: string; key: string; idempotencyKey: string }> = [];
      const dispatcher = createApiDispatcher(
        applications({
          work: {
            freeze: async (key, command) => {
              calls.push({ name: 'freeze', key, idempotencyKey: command.idempotencyKey });
              return commandResult(command.idempotencyKey);
            },
            unfreeze: async (key, command) => {
              calls.push({ name: 'unfreeze', key, idempotencyKey: command.idempotencyKey });
              return commandResult(command.idempotencyKey);
            },
            delete: async (key, command) => {
              calls.push({ name: 'delete', key, idempotencyKey: command.idempotencyKey });
              return commandResult(command.idempotencyKey);
            },
            retry: async (key, command) => {
              calls.push({ name: 'retry', key, idempotencyKey: command.idempotencyKey });
              return commandResult(command.idempotencyKey);
            },
          },
        }),
      );

      const response = await dispatcher.dispatch(
        'POST',
        `/api/v1/work-items/work%2Fdemo/commands/${name}`,
        { idempotencyKey: 'operator-42' },
      );

      expect(response?.status).toBe(name === 'delete' || name === 'retry' ? 202 : 200);
      expect(calls).toEqual([{ name, key: 'work/demo', idempotencyKey: 'operator-42' }]);
    },
  );
});

describe('API validation and conflict routes', () => {
  it('strictly validates and bounds collection queries with opaque cursors', async () => {
    const dispatcher = createApiDispatcher(
      applications({
        workItems: Array.from({ length: 4 }, (_, index) => ({
          workItemKey: `wk_${index}`,
          workItemId: `work-${index}`,
          objective: `Work ${index}`,
          state: 'open',
          relatedWorkItems: [],
        })),
      }),
    );

    const first = await dispatcher.dispatch('GET', '/api/v1/work-items?limit=2', undefined);
    expect(first?.status).toBe(200);
    expect(first?.body).toMatchObject({
      items: [{ workItemId: 'work-0' }, { workItemId: 'work-1' }],
      page: { hasMore: true, total: 4 },
      meta: { asOf: '2026-07-31T10:00:00.000Z' },
    });
    const cursor = (first?.body as { page: { nextCursor: string } }).page.nextCursor;
    expect(cursor).toMatch(/^c_/);
    const second = await dispatcher.dispatch(
      'GET',
      `/api/v1/work-items?limit=2&cursor=${cursor}`,
      undefined,
    );
    expect(second?.body).toMatchObject({
      items: [{ workItemId: 'work-2' }, { workItemId: 'work-3' }],
      page: { hasMore: false, nextCursor: null },
    });

    for (const query of ['limit=0', 'limit=201', 'limit=two', 'cursor=42', 'unknown=true']) {
      const invalid = await dispatcher.dispatch('GET', `/api/v1/work-items?${query}`, undefined);
      expect(invalid?.status, query).toBe(422);
      expect(invalid?.contentType, query).toBe('application/problem+json');
    }
  });
});

describe('API event pagination', () => {
  it('returns and accepts an opaque continuation cursor at the event stream tail', async () => {
    const positions: Array<number | undefined> = [];
    const dispatcher = createApiDispatcher(
      applications({
        eventsList: async (query) => {
          positions.push(query.cursor?.position);
          const position = (query.cursor?.position ?? 0) + 1;
          return {
            items: [
              {
                id: `event-${position}`,
                type: 'work.created',
                occurredAt: '2026-07-31T10:00:00.000Z',
                position,
              },
            ],
            continuationPosition: position,
            meta: { asOf: instant, position },
          };
        },
      }),
    );

    const first = await dispatcher.dispatch('GET', '/api/v1/events', undefined);
    expect(first?.body).toMatchObject({ page: { hasMore: false } });
    const cursor = (first?.body as { page: { nextCursor: string } }).page.nextCursor;
    expect(cursor).toMatch(/^c_/);
    await dispatcher.dispatch('GET', `/api/v1/events?cursor=${cursor}`, undefined);
    expect(positions).toEqual([undefined, 1]);
  });
});

describe('API command conflicts', () => {
  it('delegates an explicit ambiguous-run failure resolution with its operator idempotency key', async () => {
    const calls: Array<{ runId: string; idempotencyKey: string; message: string }> = [];
    const base = applications();
    const dispatcher = createApiDispatcher({
      ...base,
      execution: {
        ...base.execution,
        resolveAmbiguousRun: async (runId, command) => {
          calls.push({ runId, idempotencyKey: command.idempotencyKey, message: command.message });
          return commandResult(command.idempotencyKey);
        },
      },
    } as ApiApplications);

    const response = await dispatcher.dispatch(
      'POST',
      '/api/v1/runs/run%2Fambiguous/commands/resolve-failed',
      { idempotencyKey: 'operator-42', message: 'The external process cannot be verified.' },
    );

    expect(response?.status).toBe(202);
    expect(calls).toEqual([
      {
        runId: 'run/ambiguous',
        idempotencyKey: 'operator-42',
        message: 'The external process cannot be verified.',
      },
    ]);
  });

  it.each([
    {},
    { idempotencyKey: 'operator-42' },
    { idempotencyKey: 'operator-42', message: '' },
    { idempotencyKey: 'operator-42', message: 'reason', extra: true },
  ])('rejects an invalid ambiguous-run resolution request %#', async (body) => {
    const response = await createApiDispatcher(applications()).dispatch(
      'POST',
      '/api/v1/runs/run-ambiguous/commands/resolve-failed',
      body,
    );

    expect(response?.status).toBe(422);
    expect(response?.body).toMatchObject({ code: 'invalid-request' });
  });

  it('dispatches explicit runner pause and unpause commands', async () => {
    const calls: string[] = [];
    const base = applications();
    const dispatcher = createApiDispatcher({
      ...base,
      execution: {
        ...base.execution,
        pauseRunner: async (runnerId, command) => {
          calls.push(`pause:${runnerId}:${command.idempotencyKey}`);
          return commandResult(command.idempotencyKey);
        },
        unpauseRunner: async (runnerId, command) => {
          calls.push(`unpause:${runnerId}:${command.idempotencyKey}`);
          return commandResult(command.idempotencyKey);
        },
      },
    } as ApiApplications);

    for (const name of ['pause', 'unpause'] as const)
      expect(
        (
          await dispatcher.dispatch('POST', `/api/v1/runners/sonnet/commands/${name}`, {
            idempotencyKey: 'operator-42',
          })
        )?.status,
      ).toBe(202);
    expect(calls).toEqual(['pause:sonnet:operator-42', 'unpause:sonnet:operator-42']);
  });

  it('keeps every required unavailable command route explicit and conflicting', async () => {
    const dispatcher = createApiDispatcher(applications());
    for (const path of [
      '/api/v1/control-plane/commands/pause',
      '/api/v1/control-plane/commands/resume',
      '/api/v1/work-items/wk_demo/commands/freeze',
      '/api/v1/work-items/wk_demo/commands/unfreeze',
      '/api/v1/work-items/wk_demo/commands/delete',
      '/api/v1/work-items/wk_demo/commands/retry',
      '/api/v1/runners/runner-1/commands/unpause',
    ]) {
      const response = await dispatcher.dispatch('POST', path, { idempotencyKey: 'operator-42' });
      expect(response?.status, path).toBe(409);
      expect(response?.body, path).toMatchObject({ code: 'command-unavailable' });
    }
  });

  it('rejects malformed command bodies instead of deriving success defaults', async () => {
    const dispatcher = createApiDispatcher(
      applications({ controlPlaneTick: async () => tickCommandResult('operator-42') }),
    );
    const response = await dispatcher.dispatch('POST', '/api/v1/control-plane/commands/tick', {
      idempotencyKey: '',
    });
    expect(response?.status).toBe(422);
    expect(response?.body).toMatchObject({
      code: 'invalid-request',
      violations: [{ path: 'idempotencyKey' }],
    });
  });

  it('maps a typed public application command conflict with current state', async () => {
    const dispatcher = createApiDispatcher(
      applications({
        controlPlaneTick: async () => ({
          conflict: true,
          code: 'already-advanced',
          current: { paused: false },
        }),
      }),
    );
    const response = await dispatcher.dispatch('POST', '/api/v1/control-plane/commands/tick', {
      idempotencyKey: 'operator-42',
    });
    expect(response?.status).toBe(409);
    expect(response?.body).toMatchObject({ code: 'already-advanced', current: { paused: false } });
  });

  it('returns the retry application conflict as a 409 problem', async () => {
    const dispatcher = createApiDispatcher(
      applications({
        work: {
          retry: async () => ({
            conflict: true,
            code: 'retry-ineligible',
            detail: 'Workflow is not retry eligible',
          }),
        },
      }),
    );

    const response = await dispatcher.dispatch(
      'POST',
      '/api/v1/work-items/wk_demo/commands/retry',
      { idempotencyKey: 'operator-42' },
    );

    expect(response?.status).toBe(409);
    expect(response?.body).toMatchObject({
      code: 'retry-ineligible',
      detail: 'Workflow is not retry eligible',
    });
  });
});

function applications(
  overrides: {
    readonly work?: Partial<{
      transcript(
        key: string,
        groupId: string,
      ): Promise<ApiResourceResult<WorkItemTranscriptResponse>>;
      freeze(
        key: string,
        command: { readonly idempotencyKey: string },
      ): Promise<AcceptedCommandResponse>;
      unfreeze(
        key: string,
        command: { readonly idempotencyKey: string },
      ): Promise<AcceptedCommandResponse>;
      delete(
        key: string,
        command: { readonly idempotencyKey: string },
      ): Promise<AcceptedCommandResponse>;
      retry(key: string, command: { readonly idempotencyKey: string }): Promise<ApiCommandResult>;
    }>;
    readonly execution?: Partial<{
      transcript(runId: string): Promise<ApiResourceResult<RunTranscriptResponse>>;
    }>;
    readonly workItems?: readonly WorkItemResponse[];
    readonly controlPlaneTick?: () => Promise<
      | TickCommandResponse
      | { readonly conflict: true; readonly code: string; readonly current?: unknown }
    >;
    readonly eventsList?: (
      query: CollectionQuery,
    ) => Promise<ApiCollectionPage<AuditEventResponse>>;
  } = {},
) {
  return {
    now: () => '2026-07-31T10:00:00.000Z',
    controlPlane: {
      status: async () => resource({ paused: false, updatedAt: '2026-07-31T10:00:00.000Z' }),
      ...(overrides.controlPlaneTick === undefined ? {} : { tick: overrides.controlPlaneTick }),
    },
    work: {
      list: async (query: CollectionQuery) => workItemsPage(overrides.workItems ?? [], query),
      detail: async () => undefined,
      ...overrides.work,
    },
    resources: { list: async () => page([]) },
    orchestration: { list: async () => page([]) },
    execution: { list: async () => page([]), ...overrides.execution },
    events: { list: overrides.eventsList ?? (async () => page([])) },
    observability: {
      metrics: async () =>
        resource({
          collectedAt: '2026-07-31T10:00:00.000Z',
          window: { days: 7, from: '2026-07-25', to: '2026-07-31' },
          values: {},
        }),
    },
    system: {
      health: async () =>
        resource({
          status: 'ok' as const,
          version: '0.1.0-test',
          checkedAt: '2026-07-31T10:00:00.000Z',
        }),
      configuration: async () => resource({ configuration: {} }),
    },
  };
}

const instant = '2026-07-31T10:00:00.000Z';

function resource<T>(data: T) {
  return { data, meta: { asOf: instant } };
}

function page<T>(items: readonly T[]): ApiCollectionPage<T> {
  return { items, total: items.length, meta: { asOf: instant } };
}

function workItemsPage(
  items: readonly WorkItemResponse[],
  query: CollectionQuery,
): ApiCollectionPage<WorkItemResponse> {
  const offset = query.cursor?.position ?? 0;
  const visible = items.slice(offset, offset + query.limit);
  return {
    ...page(visible),
    total: items.length,
    ...(offset + visible.length < items.length ? { nextPosition: offset + visible.length } : {}),
  };
}

function commandResult(idempotencyKey: string): AcceptedCommandResponse {
  return {
    commandId: `command:${idempotencyKey}`,
    idempotencyKey,
    acceptedAt: '2026-07-31T10:00:00.000Z',
    status: 'accepted',
  };
}

function tickCommandResult(idempotencyKey: string): TickCommandResponse {
  return {
    ...commandResult(idempotencyKey),
    result: resource({ paused: false, updatedAt: instant }),
  };
}
