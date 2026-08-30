import { describe, expect, it } from 'vitest';

import { EventProcessorHost } from '../../../src/eventing/index.js';
import {
  BuiltInAdapterId,
  createEventDraft,
  InboundTranslator,
  integrationStream,
  type ExternalWorkObservedPayload,
} from '../../../src/integrations/github/index.js';
import {
  createInMemoryProcessorRunSerialiser,
  InMemoryCheckpointStore,
  InMemoryEventJournal,
} from '../../../src/persistence/index.js';
import { createWorkService } from '../../../src/work/index.js';
import { createTestIntakeRouting } from '../../support/intake-routing.js';
import { createTestResourceServices } from '../../support/resource-lookup.js';
import { FakeClock } from '../support/world.js';

const scenario = {
  id: 'E2E-WORK-002',
  title: 'external intake',
  given: ['provider evidence'],
  when: ['the inbound translator is replayed'],
  then: ['one canonical WorkItem and Resource remain'],
} as const;

describe(`${scenario.id} ${scenario.title}`, () => {
  it('creates one WorkItem, Resource, and primary correlation when evidence is translated twice', async () => {
    const clock = new FakeClock();
    const journal = new InMemoryEventJournal(clock);
    const { resources, lookup } = createTestResourceServices(journal);
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
      stream: integrationStream(BuiltInAdapterId.GitHub),
      payload,
    });
    await journal.append(evidence.stream, 0, [evidence]);
    const { orchestration, routing } = createTestIntakeRouting(journal, work);
    const translator = new InboundTranslator(journal, work, resources, {
      lookup,
      orchestration,
      routing,
    });

    await new EventProcessorHost(
      journal,
      checkpoints,
      createInMemoryProcessorRunSerialiser(),
    ).runOnce(translator.processor);
    await checkpoints.reset('reactor:integration.github.inbound');
    await new EventProcessorHost(
      journal,
      checkpoints,
      createInMemoryProcessorRunSerialiser(),
    ).runOnce(translator.processor);

    const resourceIdValue = await lookup.resourceIdForExternalKey({
      adapter: 'github',
      key: payload.externalKey,
    });
    expect(resourceIdValue).toMatch(/^resource-[0-9a-hjkmnp-tv-z]{26}$/);
    const resource = await resources.get(resourceIdValue!);
    expect(resource).not.toHaveProperty('raw');
    const correlations = await resources.correlations(resourceIdValue!);
    expect(correlations).toHaveLength(1);
    expect(await work.get(correlations[0]!.workItemId)).toMatchObject({ objective: payload.title });
  });
});
