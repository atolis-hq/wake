# eventing-filesystem

## Purpose

Node filesystem implementations of Eventing storage and run-serialisation
ports.

## Owns

Flat JSONL journal persistence and codec, checkpoints, rebuildable projection
storage, processor-owned state storage, atomic writes, storage-name validation,
file locks, and processor-run serialisation.

## Does not own

Event contracts or runtime policy, Wake-home path resolution, configuration,
domain facts, Bootstrap composition, or a separate infrastructure service.

## Public contracts

`index.ts` is the only supported import surface. Consumers instantiate its
adapter classes with a root and supply them through Eventing ports.

## Invariants

Existing flat journal and processor-state representations remain readable and
the adapter writes the canonical compatible format. `ProjectionStore` data is
rebuildable; `ProcessorStateStore` data is processor recovery state. A
projection store reserves the configured processor consumers' compatible state
directories when it clears projections.

## Extension rules

Keep Node filesystem detail behind Eventing ports. Do not add domain knowledge,
Wake path discovery, or a new persistence service here.
