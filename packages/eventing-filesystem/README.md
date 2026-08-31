# @atolis-hq/eventing-filesystem

Node filesystem implementations of the public storage and run-serialisation ports from
`@atolis-hq/eventing`.

```ts
import {
  FileCheckpointStore,
  FileEventJournal,
  FileProcessorStateStore,
  FileProjectionStore,
  createFileProcessorRunSerialiser,
} from '@atolis-hq/eventing-filesystem';
```

Applications supply the data root and clock. The journal preserves Wake's durable flat
JSONL segment format, while checkpoints, processor state, projections, locks, and processor serialisation
use compatible atomic filesystem operations.
