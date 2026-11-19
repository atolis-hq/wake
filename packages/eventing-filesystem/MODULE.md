# eventing-filesystem

## Purpose

Node filesystem implementations of Eventing storage and run-serialisation
ports.

## Owns

Flat JSONL journal persistence and codec, checkpoints, rebuildable projection
storage, processor-owned state storage, atomic writes, storage-name validation,
file locks, processor-run serialisation, and streaming snapshot scans that stop
at captured segment sizes and yield between batches.

## Does not own

Event contracts or runtime policy, Wake-home path resolution, configuration,
domain facts, Bootstrap composition, or a separate infrastructure service.

## Public contracts

`index.ts` is the only supported import surface. Consumers instantiate its
adapter classes with a root and supply them through Eventing ports.

## Invariants

`ProjectionStore` data is rebuildable and stored at
`projections/projection/<namespace-sha256>/<key-sha256>.json`.
`ProcessorStateStore` data is processor recovery state and stored separately at
`projections/processor-state/<consumer-sha256>/<key-sha256>.json`. Projection
clearing removes only the former subtree. Projection and processor-state paths
are fresh-only: this adapter neither reads nor migrates prior projection paths.

## Extension rules

Keep Node filesystem detail behind Eventing ports. Do not add domain knowledge,
Wake path discovery, or a new persistence service here.

The journal is multi-writer: several processes (the resident, `wake mcp serve`
per agent run, and CLI commands) append to one directory, serialised only by the
cross-process append lock. Every read reflects every append committed before the
call, including appends by other processes; there is no validity window and no
caller-selected freshness mode.

Segments are immutable and published by atomic rename. JSONL remains the sole
history authority; no migration or segment rewrite is needed. The rebuildable
`journal-index.sqlite` stores byte locations in paged global-position and
stream-sequence B-trees. It uses Node's built-in SQLite with a 2 MiB page cache
and a 256-envelope LRU cache. Reads validate requested locations against file
stats and decoded positions, streams, and sequences.

Hot readers capture index rows in a short read-only SQLite transaction and
release it before asynchronous JSONL I/O. Only appends and recovery take the
cross-process journal lock. A persisted directory
stamp detects unindexed segment publications, including unexpected clock dates.
A recovery marker is written before publishing a segment and removed only after
the index commits. Missing, corrupt, dirty, or stale indexes rebuild from JSONL;
only recovery lists the event directory. Explicit read-only diagnostic adapters
never create locks or files; their fallback index lives in memory. Index-write failure cannot fail an
already committed append. Snapshot scans capture the head, read at most 100
events per batch, and yield between batches. `fs.watch` only wakes
`waitForEventsAfter`; correctness never depends on it. Local filesystems and
same-kernel bind mounts are supported; NFS-style negative lookup caching is not.

The index also stores stream IDs and hashed top-level string payload attributes.
The optional Eventing `readLatestMatching` capability combines stream-ID and
payload-attribute matches with OR semantics, descending positions, deduplication,
and an exclusive cursor. The Work detail event feed uses this capability through
Bootstrap, preserving cross-stream matches without scanning unrelated history.

Trigger-maintained record and attribute counts are checked against the committed
head before reads and appends. Positive contiguous positions, independent counts,
and a schema-version seal detect interior omissions and missing index schema
without a full-table count. Recovery rebuilds all lookup tables from JSONL.

Read-only SQLite connections are reused in a pool of at most four paths, with
a 2 MiB page cache per connection. Every read validates the database inode and
starts a fresh snapshot; pooling does not introduce a freshness window. Replaced
or invalid indexes close their pooled connection. Windows uses transient
connections to preserve file-deletion semantics.
