import {
  DurableSubscriptionHost,
  InMemoryCheckpointStore,
  InMemoryEventJournal,
} from '../../../src/persistence/index.js';
import { FakeClock } from '../../e2e/support/world.js';

// @ts-expect-error DurableSubscriptionHost requires an explicit serialiser.
new DurableSubscriptionHost(
  new InMemoryEventJournal(new FakeClock()),
  new InMemoryCheckpointStore(),
);
