import { describe, expect, it } from 'vitest';

import {
  InboundTranslator,
  createEventDraft,
  entityRef,
  type ExternalWorkObservedPayload,
} from '../../src-next/integrations/index.js';
import { InMemoryCheckpointStore, InMemoryEventJournal } from '../../src-next/persistence/index.js';
import { createResourceService } from '../../src-next/resources/index.js';
import { createWorkService } from '../../src-next/work/index.js';
import { FakeClock } from '../e2e/support/world.js';

describe('InboundTranslator', () => {
  it('translates an external work observation into Work and Resource command candidates', () => {
    const translator = new InboundTranslator();
    const candidates = translator.translate(observation());

    expect(candidates.map((candidate) => candidate.kind)).toEqual([
      'discover-resource',
      'create-work-item',
      'correlate-resource',
    ]);
  });

  it('keeps adapter payload types inside integrations', () => {
    const candidates = new InboundTranslator().translate(observation());

    expect(JSON.stringify(candidates)).not.toContain('raw');
    expect(JSON.stringify(candidates)).not.toContain('private-provider-field');
  });

  it('reprocessing the same adapter event does not mint another WorkItem', async () => {
    const clock = new FakeClock();
    const journal = new InMemoryEventJournal(clock);
    const resources = createResourceService(journal);
    const work = createWorkService(journal);
    const checkpoints = new InMemoryCheckpointStore();
    const event = createEventDraft({
      eventId: 'github:delivery-7',
      eventType: 'integration.github.work-observed',
      occurredAt: clock.now().toISOString(),
      correlationId: 'github:delivery-7',
      causationId: 'github:delivery-7',
      actor: { kind: 'integration', id: 'github' },
      source: { kind: 'adapter', id: 'github' },
      stream: entityRef('integration', 'github'),
      payload: observation(),
    });
    await journal.append(event.stream, 0, [event]);
    const translator = new InboundTranslator(journal, checkpoints, work, resources);

    await translator.runOnce();
    await checkpoints.reset('reactor:integration.github.inbound');
    await translator.runOnce();

    expect(await work.get('work-github-owner-repo-7' as never)).not.toBeNull();
    expect(
      await resources.findByExternalKey({ adapter: 'github', key: 'owner/repo#7' }),
    ).toMatchObject({
      resourceId: 'resource-github-owner-repo-7',
    });
    expect(await resources.correlationsForWork('work-github-owner-repo-7' as never)).toHaveLength(
      1,
    );
  });
});

function observation(): ExternalWorkObservedPayload {
  return {
    externalKey: 'owner/repo#7',
    kind: 'issue',
    title: 'Improve intake',
    body: 'Body',
    state: 'open',
    revision: 'abc123',
    actor: { id: 'octocat', kind: 'human' },
    raw: { 'private-provider-field': true },
  };
}
