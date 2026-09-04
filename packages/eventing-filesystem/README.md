# @atolis-hq/eventing-filesystem

Node filesystem implementations of the public storage and run-serialisation
ports from `@atolis-hq/eventing`.

```ts
import {
  FileCheckpointStore,
  FileEventJournal,
  FileProcessorStateStore,
  FileProjectionStore,
  createFileProcessorRunSerialiser,
} from '@atolis-hq/eventing-filesystem';
```

Applications supply the data root and clock. The journal preserves Wake's
durable flat JSONL segment format, while checkpoints, processor state,
projections, locks, and processor serialisation use compatible atomic
filesystem operations.

`FileProjectionStore` is exclusively for rebuildable Eventing read models.
`FileProcessorStateStore` persists processor-owned recovery state separately.
When processor state uses established compatible paths beneath `projections/`,
pass each state consumer to `FileProjectionStore` so a projection rebuild
reserves its current, legacy, and collision-isolated directories:

```ts
const projections = new FileProjectionStore(dataRoot, {
  protectedProcessorStateConsumers: ['reactor:delivery-outcomes'],
});
const processorState = new FileProcessorStateStore(dataRoot);
```

This is structural path ownership; projection clearing never infers state from
record contents. Wake Bootstrap supplies its known processor consumers.
The adapter reads established Wake-home records without a data migration, but
does not supply a legacy source import, a compatibility package, or a second
runtime path. All supported imports come from
`@atolis-hq/eventing-filesystem`; internal codecs and storage helpers are not
public API.
