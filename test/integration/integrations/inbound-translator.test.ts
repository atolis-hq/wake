import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { activityName } from '../../../src/activities/index.js';
import { RunRepository } from '../../../src/execution/index.js';

import {
  BuiltInAdapterId,
  createEventDraft,
  GitHubEventType,
  InboundTranslator,
  integrationStream,
  type ExternalWorkObservedPayload,
} from '../../../src/integrations/github/index.js';
import { workflowName } from '../../../src/orchestration/index.js';
import { InMemoryCheckpointStore, InMemoryEventJournal } from '../../../src/persistence/index.js';
import { createWorkService } from '../../../src/work/index.js';
import { FakeClock, TestWorld } from '../../e2e/support/world.js';
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

    for (const candidate of candidates) {
      expect(candidate).not.toHaveProperty('raw');
      expect(candidate).not.toHaveProperty('private-provider-field');
    }
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

  it('records one skip diagnostic for a deleted correlation and continues later inbound work', async () => {
    const clock = new FakeClock();
    const journal = new InMemoryEventJournal(clock);
    const { resources, lookup } = createTestResourceServices(journal);
    const work = createWorkService(journal);
    const checkpoints = new InMemoryCheckpointStore();
    const { orchestration, routing } = createTestIntakeRouting(journal, work);
    const translator = new InboundTranslator(journal, checkpoints, work, resources, {
      lookup,
      orchestration,
      routing,
    });
    const initial = createEventDraft({
      eventId: 'github:issue:owner/repo#7:v1',
      eventType: 'integration.github.work-observed',
      occurredAt: clock.now().toISOString(),
      correlationId: 'github:owner/repo#7',
      causationId: 'github:issue:owner/repo#7:v1',
      actor: { kind: 'integration', id: 'github' },
      source: { kind: 'adapter', id: 'github' },
      stream: integrationStream(BuiltInAdapterId.GitHub),
      payload: observation(),
    });
    await journal.append(initial.stream, 0, [initial]);
    await translator.runOnce();
    const staleResource = await lookup.resourceIdForExternalKey({
      adapter: 'github',
      key: 'owner/repo#7',
    });
    const staleWork = (await resources.correlations(staleResource!))[0]!.workItemId;
    const deletion = {
      commandId: 'delete-stale-work',
      correlationId: 'delete-stale-work' as never,
      occurredAt: clock.now().toISOString(),
      actor: { kind: 'operator' as const, id: 'web' },
    };
    await work.delete(staleWork, deletion);
    await resources.retract(staleResource!, staleWork, deletion);
    const resumed = new InboundTranslator(journal, checkpoints, work, resources, {
      lookup,
      orchestration,
      routing,
    });

    const [ignored, admitted] = await journal.append(initial.stream, 1, [
      createEventDraft({
        eventId: 'github:issue:owner/repo#7:v2',
        eventType: 'integration.github.work-observed',
        occurredAt: clock.now().toISOString(),
        correlationId: 'github:owner/repo#7',
        causationId: 'github:issue:owner/repo#7:v2',
        actor: { kind: 'integration', id: 'github' },
        source: { kind: 'adapter', id: 'github' },
        stream: integrationStream(BuiltInAdapterId.GitHub),
        payload: { ...observation(), revision: 'def456' },
      }),
      createEventDraft({
        eventId: 'github:issue:owner/repo#8:v1',
        eventType: 'integration.github.work-observed',
        occurredAt: clock.now().toISOString(),
        correlationId: 'github:owner/repo#8',
        causationId: 'github:issue:owner/repo#8:v1',
        actor: { kind: 'integration', id: 'github' },
        source: { kind: 'adapter', id: 'github' },
        stream: integrationStream(BuiltInAdapterId.GitHub),
        payload: { ...observation(), externalKey: 'owner/repo#8', revision: 'ghi789' },
      }),
    ]);

    await expect(resumed.runOnce()).resolves.toBeGreaterThan(0);
    expect(await checkpoints.load('reactor:integration.github.inbound')).toBe(
      admitted!.globalPosition,
    );
    expect(ignored).toBeDefined();
    expect(
      await lookup.resourceIdForExternalKey({ adapter: 'github', key: 'owner/repo#8' }),
    ).not.toBeNull();
    expect(await work.get(staleWork)).toMatchObject({ deleted: true });
    expect(await resources.get(staleResource!)).toMatchObject({ revision: 'abc123' });
    const diagnostics = (
      await journal.readStream(integrationStream(BuiltInAdapterId.GitHub))
    ).filter((event) => event.eventType === GitHubEventType.DeletedWorkObservationSkipped);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      eventId: `github:deleted-work-skip:github:issue:owner/repo#7:v2:${staleWork}`,
      payload: {
        externalKey: 'owner/repo#7',
        workItemId: staleWork,
        sourceEventId: 'github:issue:owner/repo#7:v2',
        revision: 'def456',
        reason: 'work-item-deleted',
      },
    });

    // Replaying the same provider evidence after the deletion must find the
    // deterministic diagnostic instead of appending another one.
    await checkpoints.reset('reactor:integration.github.inbound');
    await checkpoints.save('reactor:integration.github.inbound', ignored!.globalPosition - 1);
    await resumed.runOnce();
    expect(
      (await journal.readStream(integrationStream(BuiltInAdapterId.GitHub))).filter(
        (event) => event.eventType === GitHubEventType.DeletedWorkObservationSkipped,
      ),
    ).toHaveLength(1);
  });

  it('grants changed-files capability to a newly admitted pull request', async () => {
    const clock = new FakeClock();
    const journal = new InMemoryEventJournal(clock);
    const { resources, lookup } = createTestResourceServices(journal);
    const work = createWorkService(journal);
    const checkpoints = new InMemoryCheckpointStore();
    const event = createEventDraft({
      eventId: 'github:pr:owner/repo#11:v1',
      eventType: 'integration.github.work-observed',
      occurredAt: clock.now().toISOString(),
      correlationId: 'github:owner/repo#11',
      causationId: 'github:owner/repo#11:v1',
      actor: { kind: 'integration', id: 'github' },
      source: { kind: 'adapter', id: 'github' },
      stream: integrationStream(BuiltInAdapterId.GitHub),
      payload: { ...observation(), kind: 'pull-request', externalKey: 'owner/repo#11' },
    });
    await journal.append(event.stream, 0, [event]);
    const { orchestration, routing } = createTestIntakeRouting(journal, work);
    const translator = new InboundTranslator(journal, checkpoints, work, resources, {
      lookup,
      orchestration,
      routing,
    });

    await translator.runOnce();

    const resourceId = await lookup.resourceIdForExternalKey({
      adapter: 'github',
      key: 'owner/repo#11',
    });
    await expect(resources.get(resourceId!)).resolves.toMatchObject({
      capabilities: expect.arrayContaining(['changed-files']),
    });
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

    const resourceId = await lookup.resourceIdForExternalKey({
      adapter: 'github',
      key: 'owner/repo#7',
    });
    await expect(resources.get(resourceId!)).resolves.toMatchObject({ title: 'Improve intake' });
  });

  it('delivers a watch-gate verdict marker from a comment to its waiting parent', async () => {
    const fixture = await waitingWatchGate();
    const translator = new InboundTranslator(
      fixture.world.journal,
      fixture.world.checkpoints,
      fixture.world.work,
      fixture.world.resources,
      {
        orchestration: fixture.world.orchestration,
        runs: new RunRepository(fixture.world.journal),
      },
    );
    const event = createEventDraft({
      eventId: 'github:comment:watch-gate-verdict',
      eventType: 'integration.github.comment-observed',
      occurredAt: fixture.world.clock.now().toISOString(),
      correlationId: 'github:atolis-hq/wake#1',
      causationId: 'github:comment:watch-gate-verdict',
      actor: { kind: 'integration', id: 'github' },
      source: { kind: 'adapter', id: 'github' },
      stream: integrationStream(BuiltInAdapterId.GitHub),
      payload: {
        reviewKind: 'issue',
        externalKey: 'atolis-hq/wake#1',
        body: watchGateVerdictMarker(fixture.run.runId),
        revision: fixture.world.clock.now().toISOString(),
        actor: { id: 'wake-bot', kind: 'bot' },
        raw: { id: 1 },
      },
    });
    await fixture.world.journal.append(event.stream, 0, [event]);

    await translator.runOnce();

    expect((await fixture.world.viewWorkflow(fixture.parent.workflowInstanceId))?.status).toBe(
      'completed',
    );
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

    expect(calls).toEqual([
      { method: 'closeWork', reason: expect.stringContaining('owner/repo#9') },
    ]);
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

    expect(calls).toEqual([
      { method: 'cancelWork', reason: expect.stringContaining('owner/repo#10') },
    ]);
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

async function waitingWatchGate() {
  const world = new TestWorld();
  world.registerActivity(testActivity('parent-work'));
  world.registerActivity(testActivity('pr-review'));
  world.configureWorkflow('pr-review', {
    stages: { review: { activity: 'pr-review', with: {}, on: { done: { then: 'done' } } } },
  });
  world.configureWorkflow('parent', {
    stages: {
      work: {
        activity: 'parent-work',
        with: {},
        on: { done: { then: 'done', watchGates: ['pr-review'] } },
      },
    },
    watches: [
      {
        id: 'pr-review',
        while: { stages: ['work'], statuses: ['waiting'] },
        on: { events: ['pr-review.requested'] },
        workflow: 'pr-review',
        maxPerGroup: 1,
      },
    ],
  });
  const work = await world.createWork({ objective: 'inbound verdict' });
  const parent = await world.startWorkflow({
    workItemId: work.workItemId,
    workflowName: workflowName('parent'),
  });
  await world.advance(work.workItemId);
  await world.advance(work.workItemId);
  await world.triggerWatch('pr-review.requested', 'pr-review-trigger');
  await world.advance(work.workItemId);
  await world.advance(work.workItemId);
  const child = (await world.orchestration.listAll()).find(
    (workflow) => workflow.parentWorkflowInstanceId === parent.workflowInstanceId,
  );
  if (child === undefined) throw new Error('Expected a watch child workflow');
  const run = (await world.viewRuns()).find(
    (candidate) => candidate.workflowInstanceId === child.workflowInstanceId,
  );
  if (run === undefined) throw new Error('Expected a real child run');
  return { world, parent, run };
}

function testActivity(name: string) {
  return {
    name: activityName(name),
    inputSchema: z.object({}).strict(),
    outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
    outcomeKinds: ['done'] as const,
    resources: [],
    executionKind: 'deterministic' as const,
    handler: {
      async execute() {
        return { kind: 'done' } as const;
      },
    },
  };
}

function watchGateVerdictMarker(runId: string): string {
  return [
    '```json',
    JSON.stringify({ wake: { watchGateVerdict: { runId, outcome: 'DONE' } } }),
    '```',
  ].join('\n');
}
