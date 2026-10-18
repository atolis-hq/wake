import { describe, expect, it, vi } from 'vitest';
import { DelegationCommands } from '../../../src/orchestration/application/delegation-commands.js';

const repositories = ['repo-a', 'repo-b'];

function commands(policy: { repositories?: string[] } = {}) {
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
    { get: async () => ({ state: 'open' }) } as never,
    { definitionFor: async () => ({ delegation }) } as never,
    { currentDefinition: () => ({ fingerprint: 'fp' }) } as never,
    { reserve } as never,
    { assertCaller: async () => undefined, repositories: async () => repositories } as never,
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
  return { submit, reserve };
}

describe('delegation repository authority', () => {
  it('never selects a repository from the permitted set when the assignment omits one', async () => {
    const { submit, reserve } = commands();
    await submit();
    const assignments = reserve.mock.calls[0]![2] as { repositoryResourceIds?: string[] }[];
    expect(assignments[0]).not.toHaveProperty('repositoryResourceIds');
  });

  it('accepts an explicit repository inside the permitted set and rejects one outside it', async () => {
    const { submit, reserve } = commands({ repositories: ['repo-a'] });
    await submit({ repositoryResourceIds: ['repo-a'] });
    expect(reserve).toHaveBeenCalledOnce();
    await expect(submit({ repositoryResourceIds: ['repo-b'] })).rejects.toThrow('authority');
  });
});
