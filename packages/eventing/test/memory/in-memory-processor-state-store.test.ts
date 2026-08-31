import type { ProcessorStateStore, StoredProcessorState } from '@atolis-hq/eventing';
import { InMemoryProcessorStateStore } from '@atolis-hq/eventing/memory';
import { expect, it } from 'vitest';

it('round-trips processor state by consumer and key', async () => {
  const store = new InMemoryProcessorStateStore();
  const port: ProcessorStateStore = store;
  const expected: StoredProcessorState<{ events: string[] }> = {
    consumer: 'reactor:delivery-outcomes',
    key: 'pending-confirmations',
    value: { events: ['event-1'] },
  };

  await port.write(expected);

  await expect(store.read('reactor:delivery-outcomes', 'pending-confirmations')).resolves.toEqual({
    consumer: 'reactor:delivery-outcomes',
    key: 'pending-confirmations',
    value: { events: ['event-1'] },
  });
});

it('isolates stored processor state from caller mutations', async () => {
  const store = new InMemoryProcessorStateStore();
  const state = { events: [{ id: 'event-1' }] };
  await store.write({
    consumer: 'reactor:delivery-outcomes',
    key: 'pending-confirmations',
    value: state,
  });
  state.events[0]!.id = 'mutated-by-writer';

  const stored = await store.read<{ events: { id: string }[] }>(
    'reactor:delivery-outcomes',
    'pending-confirmations',
  );
  stored!.value.events[0]!.id = 'mutated-by-reader';

  await expect(store.read('reactor:delivery-outcomes', 'pending-confirmations')).resolves.toEqual({
    consumer: 'reactor:delivery-outcomes',
    key: 'pending-confirmations',
    value: { events: [{ id: 'event-1' }] },
  });
});

it('deletes only the requested processor state', async () => {
  const store = new InMemoryProcessorStateStore();
  await store.write({ consumer: 'reactor:delivery-outcomes', key: 'first', value: 1 });
  await store.write({ consumer: 'reactor:delivery-outcomes', key: 'second', value: 2 });

  await store.delete('reactor:delivery-outcomes', 'first');

  await expect(store.read('reactor:delivery-outcomes', 'first')).resolves.toBeNull();
  await expect(store.read('reactor:delivery-outcomes', 'second')).resolves.toEqual({
    consumer: 'reactor:delivery-outcomes',
    key: 'second',
    value: 2,
  });
});
