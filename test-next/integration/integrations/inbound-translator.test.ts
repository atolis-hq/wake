import { describe, expect, it } from 'vitest';

import {
  BuiltInAdapterId,
  createEventDraft,
  InboundTranslator,
  integrationStream,
  type ExternalWorkObservedPayload,
} from '../../../src-next/integrations/github/index.js';
import {
  InMemoryCheckpointStore,
  InMemoryEventJournal,
} from '../../../src-next/persistence/index.js';
import { createWorkService } from '../../../src-next/work/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { createTestIntakeRouting } from '../../support/intake-routing.js';
import { createTestResourceServices } from '../../support/resource-lookup.js';

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
    const { resources, lookup } = createTestResourceServices(journal);
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
      stream: integrationStream(BuiltInAdapterId.GitHub),
      payload: observation(),
    });
    await journal.append(event.stream, 0, [event]);
    const { orchestration, routing } = createTestIntakeRouting(journal, work);
    const translator = new InboundTranslator(journal, checkpoints, work, resources, {
      lookup,
      orchestration,
      routing,
    });

    await translator.runOnce();
    await checkpoints.reset('reactor:integration.github.inbound');
    await translator.runOnce();

    const resource = await lookup.resourceIdForExternalKey({
      adapter: 'github',
      key: 'owner/repo#7',
    });
    expect(resource).toMatch(/^resource-[0-9a-hjkmnp-tv-z]{26}$/);
    expect(resource).not.toMatch(/github/);
    expect(
      await resources.correlationsForWork((await resources.correlations(resource!))[0]!.workItemId),
    ).toHaveLength(1);
  });

  it('captures the observed title on the discovered resource', async () => {
    const clock = new FakeClock();
    const journal = new InMemoryEventJournal(clock);
    const { resources, lookup } = createTestResourceServices(journal);
    const work = createWorkService(journal);
    const checkpoints = new InMemoryCheckpointStore();
    const event = createEventDraft({
      eventId: 'github:delivery-8',
      eventType: 'integration.github.work-observed',
      occurredAt: clock.now().toISOString(),
      correlationId: 'github:delivery-8',
      causationId: 'github:delivery-8',
      actor: { kind: 'integration', id: 'github' },
      source: { kind: 'adapter', id: 'github' },
      stream: integrationStream(BuiltInAdapterId.GitHub),
      payload: observation(),
    });
    await journal.append(event.stream, 0, [event]);
    const { orchestration, routing } = createTestIntakeRouting(journal, work);
    const translator = new InboundTranslator(journal, checkpoints, work, resources, {
      lookup,
      orchestration,
      routing,
    });

    await translator.runOnce();

    const resourceId = await lookup.resourceIdForExternalKey({ adapter: 'github', key: 'owner/repo#7' });
    await expect(resources.get(resourceId!)).resolves.toMatchObject({ title: 'Improve intake' });
  });
});

describe('InboundTranslator conclusion', () => {
  it('closes the work item when a re-observed issue carries a Completed outcome', async () => {
    const clock = new FakeClock();
    const journal = new InMemoryEventJournal(clock);
    const { resources, lookup } = createTestResourceServices(journal);
    const work = createWorkService(journal);
    const checkpoints = new InMemoryCheckpointStore();
    const { orchestration, routing } = createTestIntakeRouting(journal, work);
    const calls: { method: 'closeWork' | 'cancelWork'; reason: string }[] = [];
    const conclusion = {
      async closeWork(workItemId: string, reason: string) {
        calls.push({ method: 'closeWork', reason });
        return work.get(workItemId as never) as never;
      },
      async cancelWork(workItemId: string, reason: string) {
        calls.push({ method: 'cancelWork', reason });
        return work.get(workItemId as never) as never;
      },
    };
    const translator = new InboundTranslator(journal, checkpoints, work, resources, {
      lookup,
      orchestration,
      routing,
      conclusion,
    });

    const open = createEventDraft({
      eventId: 'github:issue:owner/repo#9:v1',
      eventType: 'integration.github.work-observed',
      occurredAt: clock.now().toISOString(),
      correlationId: 'github:owner/repo#9',
      causationId: 'github:owner/repo#9:v1',
      actor: { kind: 'integration', id: 'github' },
      source: { kind: 'adapter', id: 'github' },
      stream: integrationStream(BuiltInAdapterId.GitHub),
      payload: { ...observation(), externalKey: 'owner/repo#9', revision: 'v1' },
    });
    await journal.append(open.stream, 0, [open]);
    await translator.runOnce();

    const closed = createEventDraft({
      eventId: 'github:issue:owner/repo#9:v2',
      eventType: 'integration.github.work-observed',
      occurredAt: clock.now().toISOString(),
      correlationId: 'github:owner/repo#9',
      causationId: 'github:owner/repo#9:v2',
      actor: { kind: 'integration', id: 'github' },
      source: { kind: 'adapter', id: 'github' },
      stream: integrationStream(BuiltInAdapterId.GitHub),
      payload: {
        ...observation(),
        externalKey: 'owner/repo#9',
        revision: 'v2',
        state: 'closed',
        outcome: 'completed',
      },
    });
    await journal.append(closed.stream, 1, [closed]);
    await translator.runOnce();

    expect(calls).toEqual([{ method: 'closeWork', reason: expect.stringContaining('owner/repo#9') }]);
  });

  it('cancels the work item when a re-observed issue carries a Cancelled outcome', async () => {
    const clock = new FakeClock();
    const journal = new InMemoryEventJournal(clock);
    const { resources, lookup } = createTestResourceServices(journal);
    const work = createWorkService(journal);
    const checkpoints = new InMemoryCheckpointStore();
    const { orchestration, routing } = createTestIntakeRouting(journal, work);
    const calls: { method: 'closeWork' | 'cancelWork'; reason: string }[] = [];
    const conclusion = {
      async closeWork(workItemId: string, reason: string) {
        calls.push({ method: 'closeWork', reason });
        return work.get(workItemId as never) as never;
      },
      async cancelWork(workItemId: string, reason: string) {
        calls.push({ method: 'cancelWork', reason });
        return work.get(workItemId as never) as never;
      },
    };
    const translator = new InboundTranslator(journal, checkpoints, work, resources, {
      lookup,
      orchestration,
      routing,
      conclusion,
    });

    const open = createEventDraft({
      eventId: 'github:issue:owner/repo#10:v1',
      eventType: 'integration.github.work-observed',
      occurredAt: clock.now().toISOString(),
      correlationId: 'github:owner/repo#10',
      causationId: 'github:owner/repo#10:v1',
      actor: { kind: 'integration', id: 'github' },
      source: { kind: 'adapter', id: 'github' },
      stream: integrationStream(BuiltInAdapterId.GitHub),
      payload: { ...observation(), externalKey: 'owner/repo#10', revision: 'v1' },
    });
    await journal.append(open.stream, 0, [open]);
    await translator.runOnce();

    const closed = createEventDraft({
      eventId: 'github:issue:owner/repo#10:v2',
      eventType: 'integration.github.work-observed',
      occurredAt: clock.now().toISOString(),
      correlationId: 'github:owner/repo#10',
      causationId: 'github:owner/repo#10:v2',
      actor: { kind: 'integration', id: 'github' },
      source: { kind: 'adapter', id: 'github' },
      stream: integrationStream(BuiltInAdapterId.GitHub),
      payload: {
        ...observation(),
        externalKey: 'owner/repo#10',
        revision: 'v2',
        state: 'closed',
        outcome: 'cancelled',
      },
    });
    await journal.append(closed.stream, 1, [closed]);
    await translator.runOnce();

    expect(calls).toEqual([{ method: 'cancelWork', reason: expect.stringContaining('owner/repo#10') }]);
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
