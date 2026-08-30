import { expect, it, vi } from 'vitest';
import { createStatusPublishActivity } from '../../../src/bootstrap/status-publish-activity.js';
import {
  DeliveryIntentEventType,
  createDeliveryIntentEventData,
} from '../../../src/integrations/index.js';
import { EventActorKind, EventSourceKind } from '../../../src/kernel/index.js';
import { InMemoryEventJournal } from '../../../src/persistence/index.js';
import { resourceKind, resourceStream } from '../../../src/resources/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { resId, workId } from '../../support/identities.js';

it('records a status delivery intent with its exact invocation metadata', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-30T12:00:00.000Z'));
  try {
    const journal = new InMemoryEventJournal(new FakeClock());
    const activity = createStatusPublishActivity(journal);
    const resourceId = resId('status-target');

    await expect(
      activity.handler.execute(
        {
          activationId: 'activation-1' as never,
          activity: activity.name,
          workItemId: workId('work-1'),
          workflowInstanceId: 'workflow-1' as never,
          orchestrationGroupId: 'group-1' as never,
          causationId: 'cause-1' as never,
          input: { body: 'Wake started work.' },
          resources: [
            {
              resourceId,
              kind: resourceKind('issue'),
              externalKey: { adapter: 'github', key: 'o/r#1' },
              capabilities: [],
            },
          ],
        },
        {
          occurredAt: '2026-08-30T12:00:00.000Z',
          signal: new AbortController().signal,
          async reportExternalExecution() {},
        },
      ),
    ).resolves.toEqual({ kind: 'done' });

    expect(
      (await journal.readStream(resourceStream(resourceId))).map(({ event }) => event),
    ).toEqual([
      createDeliveryIntentEventData({
        eventId: 'activation-1:status.publish',
        eventType: DeliveryIntentEventType.StatusPublishRequested,
        occurredAt: '2026-08-30T12:00:00.000Z',
        correlationId: 'cause-1' as never,
        causationId: 'cause-1' as never,
        actor: { kind: EventActorKind.System, id: 'status.publish' },
        source: { kind: EventSourceKind.Internal, id: 'status.publish' },
        payload: {
          workflowInstanceId: 'workflow-1',
          activationId: 'activation-1',
          resourceId,
          body: 'Wake started work.',
        },
      }),
    ]);
  } finally {
    vi.useRealTimers();
  }
});
