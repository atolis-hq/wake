import { InMemoryEventJournal } from '@atolis-hq/eventing/memory';
import { describe, expect, it } from 'vitest';
import { resolveResourceRepositoryIdentity } from '../../../src/bootstrap/composition-root.js';
import { createDelegationAuthority } from '../../../src/bootstrap/delegation-authority.js';
import { UlidIdGenerator } from '../../../src/kernel/index.js';
import {
  BuiltInResourceKind,
  ResourceCorrelationRole,
  type ResourceService,
} from '../../../src/resources/index.js';
import { resId, workId } from '../../support/identities.js';
import { createTestResourceServices } from '../../support/resource-lookup.js';

const context = (commandId: string) => ({
  commandId,
  correlationId: 'delegation-authority' as never,
  actor: { kind: 'integration' as const, id: 'test' },
  occurredAt: '2026-10-19T12:00:00.000Z',
});

async function world() {
  const journal = new InMemoryEventJournal({ now: () => new Date() });
  const { resources } = createTestResourceServices(journal);
  const authority = createDelegationAuthority(journal, resources, {} as never, {
    ids: new UlidIdGenerator(),
    repositoryIdentity: resolveResourceRepositoryIdentity,
  });
  return { resources, authority };
}

async function admitIssue(resources: ResourceService, work: string, adapter: string, key: string) {
  await resources.discover(
    {
      resourceId: resId('issue-' + work),
      kind: BuiltInResourceKind.Issue,
      externalKey: { adapter, key },
      capabilities: [],
    },
    context('discover-' + work),
  );
  await resources.correlate(
    resId('issue-' + work),
    workId(work),
    ResourceCorrelationRole.Primary,
    context('correlate-' + work),
  );
}

const root = (work: string) => ({ workItemId: workId(work) }) as never;

describe('root repository scope binding', () => {
  it('scopes a root Issue to the repository the provider observed it in', async () => {
    const { resources, authority } = await world();
    await admitIssue(resources, 'one', 'github', 'atolis-hq/wake#962');
    await authority.bindRepositoryScope!(root('one'), context('bind'));
    const scope = await authority.repositories(root('one'));
    expect(scope).toHaveLength(1);
    const repository = (await resources.get(scope[0] as never))!;
    expect(repository.kind).toBe(BuiltInResourceKind.Repository);
    expect(repository.externalKey).toEqual({ adapter: 'github', key: 'atolis-hq/wake' });
  });

  it('is idempotent and shares one Repository Resource across roots in that repository', async () => {
    const { resources, authority } = await world();
    await admitIssue(resources, 'one', 'github', 'atolis-hq/wake#1');
    await admitIssue(resources, 'two', 'github', 'atolis-hq/wake#2');
    await authority.bindRepositoryScope!(root('one'), context('bind-one'));
    await authority.bindRepositoryScope!(root('one'), context('bind-one-again'));
    await authority.bindRepositoryScope!(root('two'), context('bind-two'));
    expect(await authority.repositories(root('two'))).toEqual(
      await authority.repositories(root('one')),
    );
    expect(await authority.repositories(root('one'))).toHaveLength(1);
  });

  it('keeps an explicitly correlated Repository Resource as the whole scope', async () => {
    const { resources, authority } = await world();
    await admitIssue(resources, 'one', 'github', 'atolis-hq/wake#1');
    await resources.discover(
      {
        resourceId: resId('declared'),
        kind: BuiltInResourceKind.Repository,
        externalKey: { adapter: 'github', key: 'atolis-hq/other' },
        capabilities: [],
      },
      context('declare'),
    );
    await resources.correlate(
      resId('declared'),
      workId('one'),
      ResourceCorrelationRole.Secondary,
      context('declare-correlate'),
    );
    await authority.bindRepositoryScope!(root('one'), context('bind'));
    expect(await authority.repositories(root('one'))).toEqual([resId('declared')]);
  });

  it.each([
    ['a provider without repository identity', 'fake', 'item-1'],
    ['a malformed provider key', 'github', 'not-a-github-key'],
  ])('grants nothing for %s', async (_name, adapter, key) => {
    const { resources, authority } = await world();
    await admitIssue(resources, 'one', adapter, key);
    await authority.bindRepositoryScope!(root('one'), context('bind'));
    expect(await authority.repositories(root('one'))).toEqual([]);
  });

  it('grants nothing to a root without a primary Issue', async () => {
    const { authority } = await world();
    await authority.bindRepositoryScope!(root('orphan'), context('bind'));
    expect(await authority.repositories(root('orphan'))).toEqual([]);
  });
});
