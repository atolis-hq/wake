import { expect, it } from 'vitest';
import {
  delegatedGrantReferences,
  withDelegatedGrants,
} from '../../../src/bootstrap/delegated-artifact-context.js';

const granted = [{ workItemId: 'work-parent', revisionId: 'brief-1' }] as never;

const grants = (parent: string | undefined) =>
  delegatedGrantReferences({
    work: {
      get: async () => ({
        delegation: parent === undefined ? undefined : { parentWorkItemId: parent },
      }),
    } as never,
    contexts: {
      childReferences: async (parentId: string) => (parentId === 'work-parent' ? granted : []),
    } as never,
  });

it('resolves a delegated child grants from its parent and nothing for other work', async () => {
  expect(await grants('work-parent')('work-child')).toEqual(granted);
  expect(await grants(undefined)('work-root')).toEqual([]);
});

it('adds granted references to the shared context an activation can read', async () => {
  const shared = withDelegatedGrants(
    async () => ({
      contextScope: 'delivery',
      sharedReferences: [{ workItemId: 'work-other', revisionId: 'memory-1' }] as never,
    }),
    async () => granted,
  );
  expect(await shared('work-child')).toEqual({
    contextScope: 'delivery',
    sharedReferences: [{ workItemId: 'work-other', revisionId: 'memory-1' }, ...granted],
  });
});

it('leaves shared context untouched when nothing is granted', async () => {
  const base = { contextScope: 'delivery' };
  expect(
    await withDelegatedGrants(
      async () => base,
      async () => [],
    )('work-root'),
  ).toBe(base);
});
