import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFakeResourceIndex } from '../../src/adapters/fake/fake-resource-index.js';
import { createStateStore } from '../../src/adapters/fs/state-store.js';
import { createDefaultWakeConfig } from '../../src/config/defaults.js';
import { createProjectionUpdater } from '../../src/core/projection-updater.js';
import { createOutbox } from '../../src/core/outbox.js';
import type { OutboundSink } from '../../src/core/contracts.js';
import { createLabelsEvent } from '../../src/core/event-builders.js';
import type { EventEnvelope, IssueStateRecord } from '../../src/domain/types.js';
import { createEventEnvelope } from '../../src/lib/event-log.js';

const clock = { now: () => new Date('2026-07-05T12:00:00.000Z') };

function labelsIntent(): EventEnvelope {
  return createLabelsEvent({
    projection: {
      workItemKey: 'work-01JZ0000000000000000000001',
      issue: { repo: 'atolis-hq/wake', number: 1 },
      origin: 'github',
    } as unknown as IssueStateRecord,
    runId: 'run-1',
    statusLabel: 'wake:status.pending',
    stageLabel: 'wake:stage.queue',
    workflowLabel: 'wake:workflow.default',
    occurredAt: clock.now().toISOString(),
  });
}

function confirmationFor(intent: EventEnvelope): EventEnvelope {
  return createEventEnvelope({
    eventId: `${intent.eventId}-updated`,
    workItemKey: intent.workItemKey,
    streamScope: 'work-item',
    direction: 'internal',
    sourceSystem: 'wake',
    sourceEventType: 'ticket.labels.updated',
    sourceRefs: intent.sourceRefs,
    occurredAt: clock.now().toISOString(),
    ingestedAt: clock.now().toISOString(),
    trigger: 'context-only',
    payload: { intentEventId: intent.eventId },
  });
}

describe('outbox', () => {
  let root: string;
  let store: ReturnType<typeof createStateStore>;
  let projectionUpdater: ReturnType<typeof createProjectionUpdater>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wake-outbox-'));
    store = createStateStore({ wakeRoot: root });
    projectionUpdater = createProjectionUpdater({
      stateStore: store,
      resourceIndex: createFakeResourceIndex(),
      config: createDefaultWakeConfig(root),
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('records a confirmation when the sink delivers with no confirmation event', async () => {
    const sink: OutboundSink = { deliverIntent: async () => [] };
    const outbox = createOutbox({
      clock,
      stateStore: store,
      outboundSink: sink,
      projectionUpdater,
    });

    const intent = labelsIntent();
    await outbox.deliverOutboundEvent(intent);

    const events = await store.listEventEnvelopes();
    expect(events.map((e) => e.eventId)).toContain(intent.eventId);
    expect(events.some((e) => e.sourceEventType === 'wake.publish.confirmed')).toBe(true);
  });

  it('records a delivery failure without throwing when the sink throws', async () => {
    const sink: OutboundSink = {
      deliverIntent: async () => {
        throw new Error('sink down');
      },
    };
    const outbox = createOutbox({
      clock,
      stateStore: store,
      outboundSink: sink,
      projectionUpdater,
    });

    await expect(outbox.deliverOutboundEvent(labelsIntent())).resolves.toBeUndefined();

    const events = await store.listEventEnvelopes();
    const failure = events.find((e) => e.sourceEventType === 'wake.publish.failed');
    expect(failure?.payload.error).toBe('sink down');
  });

  it('retries an unconfirmed intent from a prior tick', async () => {
    const attempts: string[] = [];
    const sink: OutboundSink = {
      deliverIntent: async ({ event }) => {
        attempts.push(event.eventId);
        return [confirmationFor(event)];
      },
    };
    const outbox = createOutbox({
      clock,
      stateStore: store,
      outboundSink: sink,
      projectionUpdater,
    });

    // Seed an intent event directly (as if a prior tick appended it but crashed
    // before delivery) — no confirmation on record.
    const intent = labelsIntent();
    await store.appendEventEnvelope(intent);

    await outbox.retryUnconfirmedDeliveries();

    expect(attempts).toEqual([intent.eventId]);
    const events = await store.listEventEnvelopes();
    expect(events.some((e) => e.sourceEventType === 'ticket.labels.updated')).toBe(true);
  });

  it('does not retry an intent that already has a confirmation', async () => {
    const attempts: string[] = [];
    const sink: OutboundSink = {
      deliverIntent: async ({ event }) => {
        attempts.push(event.eventId);
        return [];
      },
    };
    const outbox = createOutbox({
      clock,
      stateStore: store,
      outboundSink: sink,
      projectionUpdater,
    });

    const intent = labelsIntent();
    await store.appendEventEnvelope(intent);
    await store.appendEventEnvelope(confirmationFor(intent));

    await outbox.retryUnconfirmedDeliveries();

    expect(attempts).toEqual([]);
  });

  it('dead-letters after the maximum number of failed attempts', async () => {
    const sink: OutboundSink = {
      deliverIntent: async () => {
        throw new Error('still down');
      },
    };
    const outbox = createOutbox({
      clock,
      stateStore: store,
      outboundSink: sink,
      projectionUpdater,
    });

    const intent = labelsIntent();
    await store.appendEventEnvelope(intent);

    // Three attempts each append a wake.publish.failed; the fourth is bounded out.
    await outbox.retryUnconfirmedDeliveries();
    await outbox.retryUnconfirmedDeliveries();
    await outbox.retryUnconfirmedDeliveries();
    await outbox.retryUnconfirmedDeliveries();

    const events = await store.listEventEnvelopes();
    const failures = events.filter((e) => e.sourceEventType === 'wake.publish.failed');
    expect(failures).toHaveLength(3);
  });
});
