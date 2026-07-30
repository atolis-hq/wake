import { describe, expect, it } from 'vitest';

import {
  InboundTranslator,
  createEventDraft,
  entityRef,
  type ExternalWorkObservedPayload,
} from '../../../src-next/integrations/index.js';
import {
  InMemoryCheckpointStore,
  InMemoryEventJournal,
} from '../../../src-next/persistence/index.js';
import { createResourceService } from '../../../src-next/resources/index.js';
import { createWorkService } from '../../../src-next/work/index.js';
import { FakeClock } from '../support/world.js';

describe('E2E-WORK-002 external intake', () => {
  it('creates one WorkItem, Resource, and primary correlation when evidence is translated twice', async () => {
    const clock = new FakeClock();
    const journal = new InMemoryEventJournal(clock);
    const resources = createResourceService(journal);
    const work = createWorkService(journal);
    const checkpoints = new InMemoryCheckpointStore();
    const payload: ExternalWorkObservedPayload = {
      externalKey: 'owner/repo#7',
      kind: 'issue',
      title: 'Improve intake',
      body: 'Provider body',
      state: 'open',
      revision: 'abc123',
      actor: { id: 'octocat', kind: 'human' },
      raw: { providerOnly: true },
    };
    const evidence = createEventDraft({
      eventId: 'github:delivery-7',
      eventType: 'integration.github.work-observed',
      occurredAt: clock.now().toISOString(),
      correlationId: 'github:delivery-7',
      causationId: 'github:delivery-7',
      actor: { kind: 'integration', id: 'github' },
      source: { kind: 'adapter', id: 'github' },
      stream: entityRef('integration', 'github'),
      payload,
    });
    await journal.append(evidence.stream, 0, [evidence]);
    const translator = new InboundTranslator(journal, checkpoints, work, resources);

    await translator.runOnce();
    await checkpoints.reset('reactor:integration.github.inbound');
    await translator.runOnce();

    const resource = await resources.findByExternalKey({
      adapter: 'github',
      key: payload.externalKey,
    });
    expect(resource).toMatchObject({ resourceId: 'resource-github-owner-repo-7' });
    expect(await work.get('work-github-owner-repo-7' as never)).toMatchObject({
      objective: payload.title,
    });
    expect(await resources.correlationsForWork('work-github-owner-repo-7' as never)).toHaveLength(
      1,
    );
    expect(resource).not.toHaveProperty('raw');
  });
});
