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

`FileProjectionStore` is exclusively for rebuildable Eventing read models and
`FileProcessorStateStore` persists processor-owned recovery state separately:

```ts
const projections = new FileProjectionStore(dataRoot);
const processorState = new FileProcessorStateStore(dataRoot);
```

Projection records are stored at
`projections/projection/<namespace-sha256>/<key-sha256>.json`; processor state
is stored at `projections/processor-state/<consumer-sha256>/<key-sha256>.json`.
`FileProjectionStore.clear()` removes only the rebuildable `projection` subtree
and never infers processor state from record contents. This is a fresh-storage
format: the adapter does not read, migrate, or write prior projection paths.
All supported imports come from `@atolis-hq/eventing-filesystem`; internal
codecs and storage helpers are not public API.
