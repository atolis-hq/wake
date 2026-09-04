import {
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  InMemoryProcessorStateStore,
  InMemoryProjectionStore,
  createInMemoryProcessorRunSerialiser,
} from '@atolis-hq/eventing/memory';
import { eventingAdapterContract } from '../../../../test/contracts/eventing-adapter-contract.js';

eventingAdapterContract('memory', {
  async create(clock) {
    return {
      journal: new InMemoryEventJournal(clock),
      checkpoints: new InMemoryCheckpointStore(),
      projections: new InMemoryProjectionStore(),
      processorState: new InMemoryProcessorStateStore(),
      serialiseRun: createInMemoryProcessorRunSerialiser(),
      async dispose() {},
    };
  },
});
