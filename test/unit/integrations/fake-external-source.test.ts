import { expect, it } from 'vitest';
import {
  adapterId,
  FakeEventType,
  FakeExternalEventSource,
} from '../../../src/integrations/index.js';

it('emits stream-free event data for the poller to append to its integration stream', async () => {
  const source = new FakeExternalEventSource(adapterId('fake'), [
    { key: 'demo#1', title: 'Demo', watchEvent: FakeEventType.ReviewRequested },
  ]);

  const events = await source.poll(new AbortController().signal);

  expect(events).toHaveLength(2);
  expect(events.every((event) => !('stream' in event))).toBe(true);
});
