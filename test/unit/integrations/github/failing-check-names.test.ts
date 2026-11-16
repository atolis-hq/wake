import { createEventData, EventActorKind, EventSourceKind } from '@atolis-hq/eventing';
import { expect, it } from 'vitest';
import { integrationStream } from '../../../../src/integrations/contracts/streams.js';
import { GitHubEventType } from '../../../../src/integrations/github/contracts/events.js';
import { GitHubAdapter } from '../../../../src/integrations/github/contracts/vocabulary.js';
import { createFailingCheckNamesReader } from '../../../../src/integrations/index.js';
import { resourceKind } from '../../../../src/resources/index.js';
import { TestWorld } from '../../../e2e/support/world.js';
import { resId } from '../../../support/identities.js';

it('reads failing names for the selected PR and current head from separate provider evidence', async () => {
  const world = new TestWorld();
  const resource = await world.discoverResource({
    resourceId: resId('check-names'),
    kind: resourceKind('pull-request'),
    externalKey: { adapter: GitHubAdapter, key: 'atolis-hq/wake#8' },
    capabilities: [],
  });
  const read = createFailingCheckNamesReader(world.journal, world.resources);
  expect(await read(resource.resourceId, 'head')).toBeUndefined();
  await world.journal.appendToStream(integrationStream(GitHubAdapter), 0, [
    createEventData({
      eventId: 'check-names',
      eventType: GitHubEventType.WorkObserved,
      occurredAt: '2026-11-16T00:00:00.000Z',
      correlationId: 'check-names',
      causationId: 'check-names',
      actor: { kind: EventActorKind.Integration, id: 'github' },
      source: { kind: EventSourceKind.Adapter, id: GitHubAdapter },
      payload: {
        externalKey: 'atolis-hq/wake#8',
        kind: 'pull-request',
        title: 'Check names',
        body: '',
        state: 'open',
        revision: 'head',
        headRevision: 'head',
        baseRevision: 'base',
        checks: 'failing',
        actor: { id: 'author', kind: 'human' },
        raw: {
          checkRuns: [
            { name: 'integration', conclusion: 'failure' },
            { name: 'unit', conclusion: 'success' },
            { name: 'pending', conclusion: null },
          ],
          statuses: [{ context: 'deploy', state: 'error' }],
        },
      },
    }),
  ]);
  expect(await read(resource.resourceId, 'head')).toEqual(['integration', 'deploy']);
  expect(await read(resource.resourceId, 'superseded')).toBeUndefined();
});
