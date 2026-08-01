import { describe, expect, it } from 'vitest';

import {
  InboundTranslator,
  BuiltInAdapterId,
  createEventDraft,
  integrationStream,
  type ExternalWorkObservedPayload,
} from '../../../src-next/integrations/github/index.js';
import {
  InMemoryCheckpointStore,
  InMemoryEventJournal,
} from '../../../src-next/persistence/index.js';
import { createWorkService } from '../../../src-next/work/index.js';
import { FakeClock } from '../support/world.js';
import { createTestResourceServices } from '../../support/resource-lookup.js';
import { createTestIntakeRouting } from '../../support/intake-routing.js';

describe('E2E-WORK-002 external intake', () => {
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
    const translator = new InboundTranslator(journal, checkpoints, work, resources, {
      lookup,
      orchestration,
      routing,
    });

    await translator.runOnce();
    await checkpoints.reset('reactor:integration.github.inbound');
    await translator.runOnce();

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
