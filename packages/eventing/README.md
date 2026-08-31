# @atolis-hq/eventing

Persistence-neutral event contracts and processor runtime for Node-compatible
applications. It has no Wake bounded-module or filesystem dependency.

Import supported contracts and runtime services from the package root:

```ts
import {
  EventProcessorHost,
  createEventData,
  createProjectionProcessor,
  defineEventProcessor,
  type CheckpointStore,
  type EventJournal,
  type ProcessorStateStore,
  type ProjectionStore,
} from '@atolis-hq/eventing';
```

Import test or local in-memory adapters only from the dedicated `/memory`
subpath:

```ts
import {
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  InMemoryProcessorStateStore,
  InMemoryProjectionStore,
  InProcessJournalChangeSignal,
} from '@atolis-hq/eventing/memory';
```

`ProjectionStore` contains rebuildable read models. `ProcessorStateStore`
contains consumer-owned recovery state and is deliberately separate from a
projection. Applications supply a journal, stores, serialiser, and clock to
the runtime; concrete Node filesystem adapters are provided by
[`@atolis-hq/eventing-filesystem`](../eventing-filesystem/README.md).

The supported import surfaces are `@atolis-hq/eventing` and
`@atolis-hq/eventing/memory`; package-internal source paths are not public API.
