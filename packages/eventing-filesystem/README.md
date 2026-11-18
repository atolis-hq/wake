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

The journal stores a derived `journal-index.sqlite` beside `events/`, using
Node 24's built-in SQLite. Global-position and stream-sequence B-trees point to
JSONL byte ranges; event bodies are decoded only for requested records, with a
256-envelope LRU cache. The SQLite page cache is limited to 2 MiB. JSONL stays
authoritative and unchanged, including on existing installations: missing or
invalid indexes rebuild automatically. `journal-index.dirty` marks interrupted
publications and forces recovery under the journal lock. Old manifest files are
ignored. Index files must never be treated as a backup of event history.

Hot reads use a read-only SQLite snapshot and release it before segment I/O, so
readers do not take the append lock. Set `readOnly: true` in journal options for
diagnostics that must never create runtime files: missing or invalid indexes
then rebuild only in memory. Bootstrap uses this mode for host-side doctor,
validate-state and audit reads.

From the repository root, run `npm run benchmark:journal` for the on-demand
100k/500k scaling benchmark (one event per segment, 4 KiB payloads). It reports
p50/p95 append, head, tail, bounded replay, fixed-size stream and fresh-process
read times, with recovery measured separately. The default maximum ratio is
1.5, configurable with `JOURNAL_BENCHMARK_RATIO`. It is intentionally outside
`verify` and `verify:agent`.
