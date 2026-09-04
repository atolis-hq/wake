import * as eventing from '@atolis-hq/eventing';
import {
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  InMemoryProcessorStateStore,
  InMemoryProjectionStore,
  InProcessJournalChangeSignal,
  createInMemoryProcessorRunSerialiser,
} from '@atolis-hq/eventing/memory';
import { expect, it } from 'vitest';

it('exports in-memory Eventing adapters from the memory subpath', () => {
  const clock = { now: () => new Date('2026-08-31T12:00:00.000Z') };

  expect(new InMemoryCheckpointStore()).toBeInstanceOf(InMemoryCheckpointStore);
  expect(new InMemoryEventJournal(clock)).toBeInstanceOf(InMemoryEventJournal);
  expect(new InMemoryProcessorStateStore()).toBeInstanceOf(InMemoryProcessorStateStore);
  expect(new InMemoryProjectionStore()).toBeInstanceOf(InMemoryProjectionStore);
  expect(new InProcessJournalChangeSignal()).toBeInstanceOf(InProcessJournalChangeSignal);
  expect(createInMemoryProcessorRunSerialiser()).toBeTypeOf('function');
});

it('keeps in-memory adapters out of the primary Eventing entry', () => {
  expect(eventing).not.toHaveProperty('InMemoryCheckpointStore');
  expect(eventing).not.toHaveProperty('InMemoryEventJournal');
  expect(eventing).not.toHaveProperty('InMemoryProcessorStateStore');
  expect(eventing).not.toHaveProperty('InMemoryProjectionStore');
  expect(eventing).not.toHaveProperty('createInMemoryProcessorRunSerialiser');
  expect(eventing).not.toHaveProperty('InProcessJournalChangeSignal');
});
