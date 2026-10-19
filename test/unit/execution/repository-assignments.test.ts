import { correlationId } from '@atolis-hq/eventing';
import { InMemoryEventJournal } from '@atolis-hq/eventing/memory';
import { expect, it, vi } from 'vitest';
import {
  createRepositoryAssignments,
  type RepositoryAssignmentRequest,
} from '../../../src/execution/index.js';
import type { WorkflowInstanceView } from '../../../src/orchestration/index.js';
import { BuiltInResourceKind, ResourceCorrelationRole } from '../../../src/resources/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { resId, workId } from '../../support/identities.js';
import { createTestResourceServices } from '../../support/resource-lookup.js';

it('rejects missing and unauthorized repository targets before fetching and never widens inherited authority', async () => {
  const { resources } = createTestResourceServices(new InMemoryEventJournal(new FakeClock()));
  const parent = { workItemId: workId('authority-parent') } as WorkflowInstanceView;
  const context = {
    commandId: 'repository',
    correlationId: correlationId('repository'),
    occurredAt: '2026-10-18T12:00:00.000Z',
    actor: { kind: 'system' as const, id: 'fixture' },
  };
  const id = resId('authority-repository');
  await resources.discover(
    {
      resourceId: id,
      kind: BuiltInResourceKind.Repository,
      externalKey: { adapter: 'github', key: 'owner/repo' },
      capabilities: [],
    },
    context,
  );
  const resolveSource = vi.fn(async (request: RepositoryAssignmentRequest) => ({
    ...request,
    sourceRevision: 'a'.repeat(40),
  }));
  const repositories = createRepositoryAssignments(resources, resolveSource, async () => undefined);
  const request = { resourceId: id, sourceRef: 'main', pullRequestBase: 'main' };
  await expect(repositories.resolve(parent, request)).rejects.toThrow(
    'outside the parent assignment',
  );
  await expect(
    repositories.resolve(parent, { ...request, resourceId: resId('missing-repository') }),
  ).rejects.toThrow('select an existing Repository Resource');
  await resources.correlate(id, parent.workItemId, ResourceCorrelationRole.Secondary, context);
  const nested = createRepositoryAssignments(resources, resolveSource, async () => ({
    resourceId: resId('other-repository'),
  }));
  await expect(nested.resolve(parent, request)).rejects.toThrow('outside the parent assignment');
  expect(resolveSource).not.toHaveBeenCalled();
});
