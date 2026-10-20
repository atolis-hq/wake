import { describe, expect, it, vi } from 'vitest';
import { DelegationCommands } from '../../../src/orchestration/application/delegation-commands.js';
import { snapshotOf } from '../../support/delivery-snapshot.js';

const repositories = ['repo-a', 'repo-b'];

function commands(
  policy: { repositories?: string[] } = {},
  inherited?: string[],
  bindRepositoryScope = vi.fn(async (..._args: unknown[]) => undefined),
) {
  const parent = {
    workItemId: 'item',
    workflowInstanceId: 'parent',
    status: 'active',
    pendingActivation: { activationId: 'act' },
  };
  const reserve = vi.fn(async (...args: unknown[]) => args);
  const delegation = { workflows: ['child'], maxDepth: 1, maxDescendants: 4, ...policy };
  const subject = new DelegationCommands(
    { loadRequired: async () => ({ view: parent }) } as never,
    {
      get: async () => ({ state: 'open' }),
      deliverySnapshot: async () => snapshotOf(() => ({ state: 'open' })),
    } as never,
    { definitionFor: async () => ({ delegation }) } as never,
    { currentDefinition: () => ({ fingerprint: 'fp' }) } as never,
    {
      reserve,
      repositoryScope: async () => inherited,
      inspect: async () => [],
      attention: { current: async () => null },
    } as never,
    {
      assertCaller: async () => undefined,
      repositories: async () => repositories,
      bindRepositoryScope,
    } as never,
  );
  const caller = { workflowInstanceId: 'parent', activationId: 'act', runId: 'run' } as never;
  const assignment = {
    assignmentId: 'one',
    objective: 'Do it',
    criteria: ['Done'],
    workflowName: 'child',
    context: [],
    outputs: [{ name: 'out', path: 'out.md' }],
  };
  const submit = (extra: object = {}) =>
    subject.submit(
      caller,
      { cohortId: 'cohort', assignments: [{ ...assignment, ...extra }] } as never,
      {} as never,
    );
  const inspect = () => subject.inspect(caller, {} as never);
  return { submit, reserve, inspect, bindRepositoryScope };
}

describe('delegation repository authority', () => {
  it('binds the root scope before reading it, for submit and inspect', async () => {
    const { submit, inspect, bindRepositoryScope } = commands({ repositories: ['repo-a'] });
    await submit();
    expect(bindRepositoryScope).toHaveBeenCalledOnce();
    expect((await inspect()).repositories).toEqual(['repo-a']);
    expect(bindRepositoryScope).toHaveBeenCalledTimes(2);
  });

  it('never selects a repository from the permitted set when the assignment omits one', async () => {
    const { submit, reserve } = commands();
    await submit();
    const assignments = reserve.mock.calls[0]![2] as { repositoryResourceIds?: string[] }[];
    expect(assignments[0]).not.toHaveProperty('repository');
    expect(assignments[0]?.repositoryResourceIds).toEqual(repositories);
  });

  it('rejects a selected checkout outside policy even without a permission-list field', async () => {
    const { submit, reserve } = commands({ repositories: ['repo-a'] });
    await expect(
      submit({ repository: { resourceId: 'repo-b', sourceRef: 'main', pullRequestBase: 'main' } }),
    ).rejects.toThrow('authority');
    expect(reserve).not.toHaveBeenCalled();
  });

  it('accepts an explicit repository inside the permitted set and rejects one outside it', async () => {
    const { submit, reserve } = commands({ repositories: ['repo-a'] });
    await submit({ repositoryResourceIds: ['repo-a'] });
    expect(reserve).toHaveBeenCalledOnce();
    await expect(submit({ repositoryResourceIds: ['repo-b'] })).rejects.toThrow('authority');
  });
});

it('retains durable narrowed authority for nested requests instead of using root correlations', async () => {
  const { submit, reserve } = commands({}, ['repo-a']);
  await submit({
    repository: { resourceId: 'repo-a', sourceRef: 'main', pullRequestBase: 'main' },
  });
  expect(
    (reserve.mock.calls[0]![2] as { repositoryResourceIds: string[] }[])[0]?.repositoryResourceIds,
  ).toEqual(['repo-a']);
  await expect(
    submit({ repository: { resourceId: 'repo-b', sourceRef: 'main', pullRequestBase: 'main' } }),
  ).rejects.toThrow('authority');
  await expect(submit({ repositoryResourceIds: ['repo-a', 'repo-b'] })).rejects.toThrow(
    'authority',
  );
});

it('does not select a checkout outside the assignment narrowing', async () => {
  const { submit } = commands();
  await expect(
    submit({
      repositoryResourceIds: ['repo-a'],
      repository: { resourceId: 'repo-b', sourceRef: 'main', pullRequestBase: 'main' },
    }),
  ).rejects.toThrow('authority');
});
