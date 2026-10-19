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

Segments are immutable. Each is published by atomic rename to a name that is
never reused, and nothing rewrites or deletes one, so a segment seen once is
never stat'ed again. A listing is one directory stat, one `readdir` and a stat of
only the names not seen before; an unchanged directory is recognised from its own
stamp once that stamp is older than timestamp granularity, and a younger stamp is
always re-listed. Concurrent reads share one follow-up listing that begins after
the call, so any number of them cost at most two listings and none can be
answered by a listing that predates its call. `fs.watch` only wakes
`waitForEventsAfter`; correctness never depends on it. Local filesystems and
same-kernel bind mounts are supported; NFS-style negative lookup caching is not.
