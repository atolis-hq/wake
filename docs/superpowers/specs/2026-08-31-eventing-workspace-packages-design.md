# Eventing Workspace Packages Design

## Intent

Extract Wake's event model, event processor runtime, in-memory adapters, and
filesystem adapters into independently buildable npm workspace packages while
keeping them in this repository. The extraction makes the eventing runtime
reusable without changing Wake's event semantics, durable data, processor
identities, or runtime behaviour.

This is a package-boundary refactor, not a new eventing framework. Wake keeps
the established `EventData`, `EventEnvelope`, `EventJournal`, subscription,
projection, checkpoint, and append-to-stream patterns approved by the standard
event publishing design.

## Goals

1. Make Eventing independently buildable, testable, and publishable.
2. Keep all Node filesystem implementations out of the Eventing core package.
3. Provide filesystem and in-memory adapters with identical observable
   contracts.
4. Remove the current catch-all `src/persistence` module after every owned
   responsibility has a precise destination.
5. Preserve existing Wake homes without a journal, checkpoint, projection, or
   processor-state migration.
6. Use the repository's existing npm, TypeScript, Vitest, and architecture
   tooling; do not introduce a monorepo orchestrator or bundler.

## Non-goals

- No SQLite adapter or new infrastructure service.
- No generic command bus, aggregate framework, saga framework, or workflow
  framework.
- No change to event payloads, stream identities, processor consumers,
  checkpoints, retry policy, or push wake-up behaviour.
- No move of the Wake application into an `apps/` directory.
- No independent package version policy in the first release; the three
  published packages use Wake's release version.

## Repository layout

```text
packages/
  eventing/
    package.json
    tsconfig.json
    src/
      contracts/
      store/
      subscriptions/
      projections/
      runtime/
      memory/
      index.ts
      memory.ts
  eventing-filesystem/
    package.json
    tsconfig.json
    src/
      event-record-codec.ts
      file-event-journal.ts
      file-checkpoint-store.ts
      file-projection-store.ts
      file-processor-state-store.ts
      file-processor-run-serialiser.ts
      file-lock.ts
      storage-name.ts
      index.ts
src/
  bootstrap/
  kernel/
  work/
  resources/
  ...
```

The Wake application remains the root package. The root npm workspace list
includes `packages/*` and the existing web workspace.

## Package responsibilities

### `@atolis-hq/eventing`

Eventing owns the complete persistence-neutral eventing API and runtime:

- `EventData`, `EventEnvelope`, stream-reference, event identifier, and event
  metadata contracts;
- event construction and envelope decoding primitives;
- `EventJournal` and `JournalChangeSignal` ports;
- processor definitions, categories, replay policy, health, hosting, bounded
  catch-up, retry, cancellation, and checkpoint advancement;
- `CheckpointStore`, `ProjectionStore`, `ProjectionDefinition`,
  `ProcessorStateStore`, and `ProcessorRunSerialiser` ports;
- projection adaptation and rebuilding;
- in-memory implementations of the journal, checkpoint store, projection
  store, processor state store, change signal, and run serialiser.

The primary package entry exports contracts and runtime capabilities. Memory
implementations are exposed through `@atolis-hq/eventing/memory`, so production
consumers do not receive adapter exports accidentally.

Eventing imports no Wake bounded module, Bootstrap, Persistence, or Node
filesystem API. It must not instantiate Wake's `SystemClock`; time is supplied
through a small structural clock port or an injected `now` function. It owns
its closed processor vocabulary locally rather than depending on Wake's
Kernel vocabulary helper.

Wake's domain stream references remain structurally compatible with
Eventing's neutral stream-reference contract. Event-specific identifiers and
metadata move with Eventing. Wake-only universal primitives, relations,
general ID generation, and clocks remain in Kernel.

### `@atolis-hq/eventing-filesystem`

The filesystem package implements Eventing ports using Node filesystem APIs:

- flat JSONL event journal and record codec;
- filesystem checkpoints;
- filesystem projections;
- filesystem processor-owned state;
- cross-process processor run serialisation;
- atomic file writes, immutable journal segments, locks, storage-name
  validation, filesystem watching, and stale temporary-file recovery.

It depends only on `@atolis-hq/eventing`, its declared runtime dependencies,
and Node APIs. It receives a root directory and clock from its caller. It does
not resolve `.wake` paths, read Wake configuration, import bounded event
contracts, or construct Bootstrap applications.

Low-level locking helpers stay private unless a non-Eventing consumer has a
demonstrated stable need. Wake's existing activation scheduler may continue to
adapt the exported filesystem run serialiser using its fixed consumer identity;
that does not make Eventing depend on Control Plane.

### Wake application

Bootstrap resolves Wake paths and selects concrete adapters. Bounded modules
depend on `@atolis-hq/eventing` contracts for event publication and processor
definitions. They do not depend on the filesystem package.

Wake-specific filesystem concerns remain with their owning infrastructure:
workspaces and transcripts in Execution, provider fakes in Integrations,
schedule checkpoints and update state at the Bootstrap/Control Plane boundary,
and packaged assets in Surfaces. They are not Eventing persistence.

## Processor-owned recovery state

Delivery pending-confirmation recovery is durable processor state, not a
rebuildable projection. Eventing therefore defines a distinct
`ProcessorStateStore` port with consumer-scoped keys and opaque typed values.

The delivery outcome reactor uses this port under its existing processor run
serialiser. Projection code continues to use `ProjectionStore` and its global
position semantics. The filesystem processor-state adapter must read the
existing pending-confirmation representation and location and continue writing
a compatible canonical representation, so existing Wake homes need no rewrite
or runtime compatibility mode.

## Fate of `src/persistence`

The current module is removed completely:

| Current responsibility | Destination |
| --- | --- |
| In-memory journal | `@atolis-hq/eventing/memory` |
| In-memory checkpoints | `@atolis-hq/eventing/memory` |
| In-memory projections | `@atolis-hq/eventing/memory` |
| In-memory run serialiser | `@atolis-hq/eventing/memory` |
| File event journal and codec | `@atolis-hq/eventing-filesystem` |
| File checkpoints and projections | `@atolis-hq/eventing-filesystem` |
| File processor state | `@atolis-hq/eventing-filesystem` |
| File run serialiser and locks | `@atolis-hq/eventing-filesystem` |

No residual general-purpose Persistence module remains. A future unrelated
storage adapter belongs to the module whose port it implements, not to a new
miscellaneous persistence bucket.

## Public API and imports

Wake production code imports only package entry points:

```ts
import { EventProcessorHost, type EventJournal } from '@atolis-hq/eventing';
import { InMemoryEventJournal } from '@atolis-hq/eventing/memory';
import { FileEventJournal } from '@atolis-hq/eventing-filesystem';
```

There are no compatibility re-exports from `src/kernel`, `src/eventing`, or
`src/persistence`. The migration is completed atomically so old and new import
surfaces cannot diverge.

Package exports expose only deliberate entry points. Internal codecs, lock
files, storage names, and implementation helpers are not public unless needed
to implement a stable cross-package contract.

## Build and workspace setup

The repository continues to use npm workspaces. A shared `tsconfig.base.json`
holds strict compiler options. Each package has a composite TypeScript project
that emits JavaScript, declarations, and source maps into its own `dist/`.
The Wake application has its own referenced TypeScript project.

The project-reference build order is:

```text
@atolis-hq/eventing
        ↓
@atolis-hq/eventing-filesystem
        ↓
@atolis-hq/wake
```

The root build invokes `tsc -b` for these projects before the existing version
embedding and CLI-entrypoint checks. Focused package builds remain available
through workspace scripts. Docker copies the package manifests and sources
before dependency installation and uses the same project-reference build.

Wake is already published to npm. To avoid adding a bundler or shipping broken
workspace links, Eventing and its filesystem adapter are publishable packages
from the first extracted release. The release job assigns the same semantic
version to all three packages and publishes them in dependency order:
Eventing, Eventing Filesystem, then Wake. Local installs use npm workspace
links. Package dependency ranges are rewritten or validated against the release
version by a small deterministic release check.

The existing web workspace and its build remain unchanged apart from the root
workspace list.

## Tests and verification

The same behavioural adapter contract suite runs against memory and filesystem
implementations. It proves append ordering, expected-sequence rejection,
atomic batches, metadata assignment, notifications, checkpoint monotonicity,
projection persistence, processor-state persistence, run serialisation, and
existing flat-record compatibility.

Package-local tests cover the Eventing host and adapters. Wake's unit,
integration, E2E, and web tests continue to run from the root and consume the
workspace packages by their public exports.

Architecture checks enforce:

1. Eventing imports no Wake source module or Node filesystem API.
2. Eventing Filesystem imports only Eventing, declared dependencies, and Node.
3. Bounded Wake modules do not import Eventing Filesystem.
4. Bootstrap is the production composition boundary for filesystem adapters.
5. No production import refers to removed `src/eventing`, `src/persistence`, or
   Kernel event-contract paths.
6. Only journal adapters construct envelopes or persistence metadata.
7. Package internals are reachable only through declared exports.

Final verification runs package builds and tests, Wake's complete verification
matrix, npm package dry-runs for all three published packages, and the Docker
smoke build.

## Migration sequence

1. Introduce workspace manifests, shared compiler configuration, package
   exports, and failing package-boundary tests.
2. Move Eventing contracts/runtime and remove its Kernel/concrete clock
   dependencies.
3. Move in-memory adapters behind the Eventing memory subpath.
4. Move filesystem adapters, codecs, locking, and recovery into Eventing
   Filesystem.
5. Introduce `ProcessorStateStore` and migrate delivery recovery without
   changing stored data.
6. Update Wake imports, Bootstrap composition, tests, architecture rules,
   Docker build inputs, unused-code configuration, and release workflow.
7. Remove `src/eventing` and `src/persistence`, update active module
   documentation, and run the complete verification matrix.

Each slice must compile and pass its focused contract tests before the next
slice. There is no feature flag, dual runtime, compatibility package, or
alternate persistence mode.

## Success criteria

- Eventing and Eventing Filesystem build and test independently.
- Eventing contains no filesystem imports or Wake source dependencies.
- Eventing Filesystem contains all eventing-related filesystem implementation.
- Memory and filesystem adapters satisfy the same contract tests.
- `src/persistence` and the old `src/eventing` implementation are removed.
- Existing Wake homes and event files run without migration.
- Wake's published package resolves only published workspace dependencies.
- Processor identities, checkpoints, projections, wake-up latency, retry,
  cancellation, and rebuild behaviour are unchanged.
- Full verification, package dry-runs, and Docker smoke pass.
