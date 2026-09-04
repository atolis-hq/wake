# Eventing Workspace Packages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract Wake's eventing runtime, memory adapters, and filesystem adapters into public npm workspace packages without changing runtime behaviour or stored data.

**Architecture:** `@atolis-hq/eventing` owns persistence-neutral event/store, subscription, projection, processor-state, and memory-adapter APIs. `@atolis-hq/eventing-filesystem` implements those ports with Node filesystem primitives. Wake consumes both through package exports, Bootstrap composes them, and the old `src/eventing` and `src/persistence` modules are removed.

**Tech Stack:** Node 24, TypeScript 6 project references, npm workspaces, Vitest 4, Zod 4, dependency-cruiser, ESLint, Prettier.

---

### Task 1: Establish workspace and package build contracts

**Files:**
- Create: `tsconfig.base.json`
- Create: `tsconfig.app.json`
- Create: `packages/eventing/package.json`
- Create: `packages/eventing/tsconfig.json`
- Create: `packages/eventing-filesystem/package.json`
- Create: `packages/eventing-filesystem/tsconfig.json`
- Create: `test/architecture/workspace-packages.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tsconfig.json`
- Modify: `tsconfig.docker.json`
- Modify: `vitest.architecture.config.ts`

- [ ] **Step 1: Verify the public package names are available**

Run:

```powershell
npm view @atolis-hq/eventing version
npm view @atolis-hq/eventing-filesystem version
```

Expected: npm reports `E404` for both names. If either exists outside this
repository, stop and report the collision rather than selecting another name.

- [ ] **Step 2: Write the failing workspace architecture test**

Create a test that reads the three manifests and asserts:

```ts
expect(root.workspaces).toContain('packages/*');
expect(eventing.private).not.toBe(true);
expect(eventing.publishConfig).toEqual({ access: 'public' });
expect(filesystem.dependencies['@atolis-hq/eventing']).toBe(eventing.version);
expect(wake.dependencies['@atolis-hq/eventing']).toBe(eventing.version);
expect(wake.dependencies['@atolis-hq/eventing-filesystem']).toBe(filesystem.version);
```

- [ ] **Step 3: Run the test and observe RED**

Run:

```powershell
npx vitest run --config vitest.architecture.config.ts test/architecture/workspace-packages.test.ts
```

Expected: FAIL because the package manifests and workspace entry do not exist.

- [ ] **Step 4: Add manifests and project references**

Use package names and public exports:

```json
{
  "name": "@atolis-hq/eventing",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./memory": { "types": "./dist/memory.d.ts", "default": "./dist/memory.js" }
  },
  "files": ["dist", "README.md", "LICENSE"],
  "publishConfig": { "access": "public" }
}
```

Filesystem exports use the same shape with one primary entry and an exact
dependency on `@atolis-hq/eventing`. Add `packages/*` to root workspaces and
exact root dependencies on both packages. Split compiler options into
`tsconfig.base.json`; make both packages composite declaration projects; make
`tsconfig.app.json` reference them; make root `tsconfig.json` the solution.

- [ ] **Step 5: Refresh the lock file and verify GREEN**

Run:

```powershell
npm install --package-lock-only
npx vitest run --config vitest.architecture.config.ts test/architecture/workspace-packages.test.ts
```

Expected: PASS and the lock file records both workspace links.

- [ ] **Step 6: Commit**

```powershell
git add package.json package-lock.json tsconfig.json tsconfig.base.json tsconfig.app.json tsconfig.docker.json packages test/architecture/workspace-packages.test.ts vitest.architecture.config.ts
git commit -m "build: establish eventing workspace packages"
```

### Task 2: Move neutral event contracts and processor runtime into Eventing

**Files:**
- Create/move under: `packages/eventing/src/contracts/`
- Create/move under: `packages/eventing/src/store/`
- Create/move under: `packages/eventing/src/subscriptions/`
- Create/move under: `packages/eventing/src/projections/`
- Create/move under: `packages/eventing/src/runtime/`
- Create: `packages/eventing/src/index.ts`
- Create: `packages/eventing/README.md`
- Move tests into: `packages/eventing/test/`
- Modify: `src/kernel/index.ts`
- Modify: `src/kernel/contracts/commands.ts`
- Modify: `src/kernel/contracts/identifiers.ts`
- Modify: `src/bootstrap/event-processor-runtime.ts`
- Modify imports throughout: `src/**/*.ts`, `test/**/*.ts`
- Remove migrated files from: `src/kernel/`, `src/eventing/`

- [ ] **Step 1: Move the existing Eventing tests first and make package imports fail**

Move the host, projection, health, event-envelope, event-decoding, and change
signal tests under `packages/eventing/test`. Change them to import the desired
public package entry:

```ts
import {
  EventProcessorHost,
  createEventData,
  type EventEnvelope,
  type EventJournal,
} from '@atolis-hq/eventing';
```

- [ ] **Step 2: Run the package tests and observe RED**

Run:

```powershell
npm test --workspace @atolis-hq/eventing
```

Expected: FAIL because package exports have no implementation.

- [ ] **Step 3: Move event/store contracts and remove Wake dependencies**

Move `EventData`, `EventEnvelope`, event identifiers, actor/source metadata,
schemas, `createEventData`, `EventJournal`, `WrongExpectedSequenceError`,
`JournalChangeSignal`, `CheckpointStore`, `ProjectionDefinition`,
`ProjectionStore`, processor contracts, and processor runtime.

Define the neutral stream and clock boundaries inside Eventing:

```ts
export interface StreamRef<Kind extends string = string, Id extends string = string> {
  readonly kind: Kind;
  readonly id: Id;
}

export interface EventingClock {
  now(): Date;
}
```

Wake's `EntityRef` remains structurally compatible. Move `CommandContext` with
event actor and correlation metadata into Eventing. Replace Eventing's use of
Kernel `defineClosedVocabulary` with local frozen `as const` values. Require an
injected Eventing clock in `EventProcessorHost`; do not instantiate
`SystemClock` inside the package.

- [ ] **Step 4: Export only the supported Eventing surface**

`packages/eventing/src/index.ts` exports contracts and runtime but no memory or
filesystem implementations. It must not export internal validation helpers.

- [ ] **Step 5: Migrate Wake imports atomically**

Update all producers, decoders, repositories, processors, Bootstrap code,
surfaces, and tests to import event types and runtime from
`@atolis-hq/eventing`. Keep generic Kernel imports such as `EntityRef`,
relations, general clocks, and ID generators in Kernel. Remove event exports
from Kernel and remove `src/eventing` after `rg` shows no consumers:

```powershell
rg -n "src/eventing|eventing/index|kernel/(contracts/(events|event-journal|event-schema|checkpoint-store|projection-store|journal-change-signal)|domain/event-envelope)" src test packages
```

Expected: no production import of removed paths.

- [ ] **Step 6: Verify package and Wake compilation**

Run:

```powershell
npm run build --workspace @atolis-hq/eventing
npm test --workspace @atolis-hq/eventing
npm run build
npm run test:fast
```

Expected: all commands pass with unchanged behavioural assertions.

- [ ] **Step 7: Commit**

```powershell
git add packages/eventing src/kernel src test package.json package-lock.json
git commit -m "refactor: extract eventing core package"
```

### Task 3: Move in-memory adapters behind the memory subpath

**Files:**
- Move: `src/persistence/memory/in-memory-event-journal.ts` → `packages/eventing/src/memory/in-memory-event-journal.ts`
- Move: `src/persistence/memory/in-memory-checkpoint-store.ts` → `packages/eventing/src/memory/in-memory-checkpoint-store.ts`
- Move: `src/persistence/memory/in-memory-projection-store.ts` → `packages/eventing/src/memory/in-memory-projection-store.ts`
- Split: `src/persistence/application/processor-run-serialiser.ts`
- Create: `packages/eventing/src/memory/in-memory-processor-run-serialiser.ts`
- Create: `packages/eventing/src/memory.ts`
- Move/create tests under: `packages/eventing/test/memory/`
- Modify imports throughout: `test/**/*.ts`, `src/**/*.ts`

- [ ] **Step 1: Add a failing memory export test**

```ts
import {
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  InMemoryProjectionStore,
  createInMemoryProcessorRunSerialiser,
} from '@atolis-hq/eventing/memory';

expect(new InMemoryEventJournal(clock)).toBeDefined();
expect(new InMemoryCheckpointStore()).toBeDefined();
expect(new InMemoryProjectionStore()).toBeDefined();
expect(createInMemoryProcessorRunSerialiser()).toBeTypeOf('function');
```

- [ ] **Step 2: Run and observe RED**

Run `npm test --workspace @atolis-hq/eventing`.

Expected: FAIL because the memory subpath is empty.

- [ ] **Step 3: Move adapters without changing semantics**

Move the existing implementations and update them to import their contracts
locally. Keep constructor APIs, expected-sequence behaviour, notification
behaviour, projection semantics, and serial execution unchanged.

- [ ] **Step 4: Replace all Wake memory imports**

Change consumers from the removed Persistence barrel to
`@atolis-hq/eventing/memory`. The primary Eventing entry must not re-export
these symbols.

- [ ] **Step 5: Verify and commit**

Run:

```powershell
npm test --workspace @atolis-hq/eventing
npm run build
npm run test:fast
```

Then commit:

```powershell
git add packages/eventing src test src/persistence
git commit -m "refactor: move memory adapters into eventing"
```

### Task 4: Extract the filesystem adapter package

**Files:**
- Move all: `src/persistence/filesystem/*.ts` → `packages/eventing-filesystem/src/`
- Move filesystem half of: `src/persistence/application/processor-run-serialiser.ts`
- Create: `packages/eventing-filesystem/src/index.ts`
- Create: `packages/eventing-filesystem/README.md`
- Move tests into: `packages/eventing-filesystem/test/`
- Modify: `src/bootstrap/persistence-composition.ts`
- Modify: `src/bootstrap/activation-scheduler-serialiser.ts`
- Modify imports throughout: `src/**/*.ts`, `test/**/*.ts`

- [ ] **Step 1: Move filesystem contract tests and observe RED**

Tests import only:

```ts
import {
  FileCheckpointStore,
  FileEventJournal,
  FileProjectionStore,
  createFileProcessorRunSerialiser,
} from '@atolis-hq/eventing-filesystem';
```

Run `npm test --workspace @atolis-hq/eventing-filesystem`.

Expected: FAIL because exports are not implemented.

- [ ] **Step 2: Move filesystem implementations**

Preserve exact flat JSONL encoding, immutable segment names, fsync/rename
commit, stale temp cleanup, watcher behaviour, manifest fallback, checkpoint
format, projection format, lock ownership, and cancellation semantics. Import
all ports from `@atolis-hq/eventing`; import no Wake source file.

- [ ] **Step 3: Compose through public exports**

Bootstrap resolves `paths.dataRoot` and constructs filesystem adapters. The
activation scheduler may adapt the exported file run serialiser with its fixed
consumer identity. No bounded module imports this package.

- [ ] **Step 4: Run adapter and compatibility verification**

```powershell
npm run build --workspace @atolis-hq/eventing-filesystem
npm test --workspace @atolis-hq/eventing-filesystem
npx vitest run test/e2e/scenarios/journal-restart.test.ts test/e2e/scenarios/projection-recovery.test.ts
```

Expected: all pass and existing fixture files decode unchanged.

- [ ] **Step 5: Commit**

```powershell
git add packages/eventing-filesystem src/bootstrap src/persistence test package.json package-lock.json
git commit -m "refactor: extract eventing filesystem package"
```

### Task 5: Separate processor state from rebuildable projections

**Files:**
- Create: `packages/eventing/src/contracts/processor-state-store.ts`
- Create: `packages/eventing/src/memory/in-memory-processor-state-store.ts`
- Create: `packages/eventing-filesystem/src/file-processor-state-store.ts`
- Create tests in both package test trees
- Modify: `src/integrations/delivery/application/delivery-outcome-reactor.ts`
- Modify: `src/bootstrap/integration-runtime.ts`
- Modify: `src/bootstrap/persistence-composition.ts`
- Modify: `test/unit/integrations/delivery-outcome-reactor.test.ts`

- [ ] **Step 1: Write failing port and compatibility tests**

Define the desired port:

```ts
export interface StoredProcessorState<Value> {
  readonly consumer: string;
  readonly key: string;
  readonly value: Value;
}

export interface ProcessorStateStore {
  read<Value>(consumer: string, key: string): Promise<StoredProcessorState<Value> | null>;
  write<Value>(state: StoredProcessorState<Value>): Promise<void>;
  delete(consumer: string, key: string): Promise<void>;
}
```

Tests prove memory round-trip, filesystem atomic round-trip, deletion, invalid
names, and reading the existing delivery pending-confirmation file at its
current path and representation.

- [ ] **Step 2: Run and observe RED**

Run both package test commands and the delivery reactor unit test.

Expected: FAIL because the port/adapters and reactor dependency do not exist.

- [ ] **Step 3: Implement adapters and migrate the reactor**

The delivery reactor receives both `ProjectionStore` for delivery-intent reads
and `ProcessorStateStore` for pending confirmations. Continue using consumer
`reactor:delivery-outcomes` and key `pending-confirmations`. Preserve the
existing serialiser and legacy/interim record decoding. The filesystem adapter
must keep the existing durable location so no migration is required.

- [ ] **Step 4: Verify concurrency and recovery**

```powershell
npx vitest run test/unit/integrations/delivery-outcome-reactor.test.ts
npm test --workspace @atolis-hq/eventing
npm test --workspace @atolis-hq/eventing-filesystem
npx vitest run test/e2e/scenarios/outbox-crash.test.ts test/e2e/scenarios/lifecycle-ticket-delivery.test.ts
```

Expected: all pass, including the deterministic live/reconcile interleaving.

- [ ] **Step 5: Commit**

```powershell
git add packages src/bootstrap src/integrations test
git commit -m "refactor: separate processor recovery state"
```

### Task 6: Remove old modules and enforce package boundaries

**Files:**
- Remove: `src/eventing/`
- Remove: `src/persistence/`
- Modify: `scripts/check-event-architecture.mjs`
- Modify: `scripts/check-event-architecture.d.mts`
- Modify: `scripts/check-module-manifests.mjs`
- Modify: `scripts/report-spec-drift.mjs`
- Modify: `dependency-cruiser.config.mjs`
- Modify: `knip.json`
- Modify architecture tests under: `test/architecture/`

- [ ] **Step 1: Add failing package-boundary fixtures**

Add fixtures proving:

- Eventing importing `node:fs` fails.
- Eventing importing `src/kernel` or a bounded module fails.
- Eventing Filesystem importing a Wake source module fails.
- Work importing Eventing Filesystem fails.
- Bootstrap importing Eventing Filesystem passes.
- direct package-internal imports fail.
- journal-only envelope construction remains enforced in the new locations.

- [ ] **Step 2: Run architecture tests and observe RED**

Run `npm run test:architecture`.

Expected: new fixtures fail under rules that still understand only `src/`.

- [ ] **Step 3: Update symbol-aware checks and dependency rules**

Teach architecture tooling the package source roots and public entries. Replace
old Kernel/Eventing/Persistence allowlists with package-owned symbol locations.
Keep alias, namespace, destructuring, tuple, re-export, and type-only coverage.
Delete obsolete module-manifest entries rather than retaining compatibility
exceptions.

- [ ] **Step 4: Prove the old surfaces are gone**

```powershell
rg -n "src/(eventing|persistence)|from ['\"].*(eventing|persistence)/index" src packages test scripts
```

Expected: only intentional negative architecture fixtures or historical design
documents match.

- [ ] **Step 5: Verify and commit**

```powershell
npm run test:architecture
npm run lint:architecture
npm run knip
npm run build
git add packages src scripts test dependency-cruiser.config.mjs knip.json
git commit -m "test: enforce eventing package boundaries"
```

### Task 7: Update Docker, packaging, and public release

**Files:**
- Create: `scripts/check-workspace-packages.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.github/workflows/ci-cd.yml`
- Modify: `docker/Dockerfile`
- Modify: `docker/Dockerfile.packaged`
- Modify: `scripts/embed-version.mjs`
- Modify: `scripts/check-cli-entrypoint.mjs`

- [ ] **Step 1: Write a failing package dry-run/install check**

The script must:

1. assert synchronized versions and exact internal dependency versions;
2. run `npm pack --dry-run --json` for both dependency packages and Wake;
3. assert each tarball contains its `dist` entry and declarations;
4. pack all three into a temporary directory;
5. install Wake plus its two local tarball dependencies into a clean temporary
   directory; and
6. run `node node_modules/@atolis-hq/wake/dist/src/main.js --help`.

- [ ] **Step 2: Run and observe RED**

Run `node scripts/check-workspace-packages.mjs`.

Expected: FAIL because release/Docker packaging is not workspace-aware.

- [ ] **Step 3: Update build and release workflows**

Root build uses TypeScript project references. Docker copies all workspace
manifests before `npm ci`, then package sources before the build. CI sets the
same version in Eventing, Eventing Filesystem, and Wake; validates exact
internal dependency ranges; publishes Eventing, then Eventing Filesystem, then
Wake with public access and provenance. Do not use `npm publish --workspaces`
because dependency order must be explicit.

- [ ] **Step 4: Verify package and Docker artifacts**

```powershell
node scripts/check-workspace-packages.mjs
npm run build:docker
docker build -f docker/Dockerfile .
```

Expected: local tarball install and Docker smoke build pass.

- [ ] **Step 5: Commit**

```powershell
git add package.json package-lock.json scripts .github/workflows/ci-cd.yml docker
git commit -m "build: publish eventing workspace packages"
```

### Task 8: Update active documentation and run full verification

**Files:**
- Create: `packages/eventing/MODULE.md`
- Create: `packages/eventing/SPEC.md`
- Create: `packages/eventing-filesystem/MODULE.md`
- Create: `packages/eventing-filesystem/SPEC.md`
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/events.md`
- Modify active module specs under: `src/*/SPEC.md`
- Modify: `docs/superpowers/specs/2026-08-30-standard-event-publishing-design.md` only if it is explicitly marked as superseded by this approved package-boundary design; do not rewrite its historical decisions.

- [ ] **Step 1: Update current-state documentation**

Document the package graph, public import surfaces, Eventing/Filesystem
responsibilities, ProcessorStateStore distinction, Bootstrap composition, and
release order. Remove `persistence` from the active module topology. Historical
ADRs, plans, reports, and specifications remain unchanged except for an
explicit supersession pointer where required for clarity.

- [ ] **Step 2: Synchronize active module specifications**

Review every source module changed by import ownership and advance only current
`SPEC.md` markers after confirming their descriptions match the implementation.

- [ ] **Step 3: Run the complete verification matrix**

```powershell
npm run verify
npm run test:architecture
npm run test:integration
npm run test:e2e
npm run test:web
npm run knip
node scripts/check-workspace-packages.mjs
git diff --check
```

Expected: all commands pass; package and Wake test counts contain zero failures.

- [ ] **Step 4: Request independent spec and quality reviews**

Spec review checks every success criterion in
`docs/superpowers/specs/2026-08-31-eventing-workspace-packages-design.md`.
Quality review checks public API shape, package resolution, storage
compatibility, processor-state recovery, lock/notification semantics, package
contents, Docker operation, and architecture-checker coverage. Fix every
Critical or Important finding test-first and rerun the complete matrix.

- [ ] **Step 5: Commit documentation and final remediation**

```powershell
git add AGENTS.md README.md docs packages src
git commit -m "docs: describe eventing workspace architecture"
```
