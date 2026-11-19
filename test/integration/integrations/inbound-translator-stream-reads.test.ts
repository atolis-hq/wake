import { createEventData, EventProcessorHost } from '@atolis-hq/eventing';
import { FileEventJournal } from '@atolis-hq/eventing-filesystem';
import {
  createInMemoryProcessorRunSerialiser,
  InMemoryCheckpointStore,
} from '@atolis-hq/eventing/memory';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  BuiltInAdapterId,
  GitHubEventType,
  InboundTranslator,
  integrationStream,
} from '../../../src/integrations/github/index.js';
import { createWorkService } from '../../../src/work/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { createTestIntakeRouting } from '../../support/intake-routing.js';
import { createTestResourceServices } from '../../support/resource-lookup.js';

// The integration stream grows without bound; translating an observation must
// consult it through the payload index, never by reading the whole stream.
it('translates observations without reading the whole integration stream', async () => {
  const clock = new FakeClock();
  const journal = new FileEventJournal(await mkdtemp(join(tmpdir(), 'wake-translate-')), clock);
  const stream = integrationStream(BuiltInAdapterId.GitHub);
  await journal.appendToStream(
    stream,
    0,
    Array.from({ length: 5 }, (_, index) =>
      createEventData({
        eventId: `github:issue:owner/repo#${index}:v1`,
        eventType: GitHubEventType.WorkObserved,
        occurredAt: clock.now().toISOString(),
        correlationId: `github:${index}`,
        causationId: `github:${index}`,
        actor: { kind: 'integration', id: 'github' },
        source: { kind: 'adapter', id: 'github' },
        payload: {
          externalKey: `owner/repo#${index}`,
          kind: 'issue' as const,
          title: 'Improve intake',
          body: 'Body',
          state: 'open' as const,
          revision: 'abc123',
          actor: { id: 'octocat', kind: 'human' as const },
          raw: {},
        },
      }),
    ),
  );
  const { resources, lookup } = createTestResourceServices(journal);
  const work = createWorkService(journal);
  const { orchestration, routing } = createTestIntakeRouting(journal, work);
  const translator = new InboundTranslator(journal, work, resources, {
    lookup,
    orchestration,
    routing,
  });
  const checkpoints = new InMemoryCheckpointStore();
  const host = new EventProcessorHost(
    journal,
    checkpoints,
    createInMemoryProcessorRunSerialiser(),
    clock,
  );
  expect(await host.runOnce(translator.processor)).toMatchObject({ handledCount: 5 });

  // Replaying admitted observations only looks facts up; it never appends.
  const readStream = vi.spyOn(journal, 'readStream');
  await checkpoints.reset(translator.processor.consumer);
  expect(await host.runOnce(translator.processor)).toMatchObject({ handledCount: 5 });
  const integrationReads = readStream.mock.calls.filter(
    ([read]) => read.kind === stream.kind && read.id === stream.id,
  );
  expect(integrationReads).toHaveLength(0);
});
