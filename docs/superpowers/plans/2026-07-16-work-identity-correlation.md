# Work Identity and Correlation Vocabulary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Wake's ticket-coupled work identity with a minted provider-independent work ID, and lock the durable correlation event shapes, while the one-time fresh start of `.wake/` makes the cutover free.

**Architecture:** Correlation lands first as an event-sourced registry (registration events → projection fold → hash-sharded reverse index) on today's ticket-shaped keys, so it ships green and fully tested. The identity flip then only changes which _values_ flow through that existing machinery: sources stop self-keying and emit `sourceRefs.resourceUri` on unkeyed events, a central resolver in `tick-runner` resolves the URI through the index (minting `work-<ulid>` on a miss), and all `.wake/` paths flatten to the opaque work ID.

**Tech Stack:** TypeScript, zod, vitest, `ulid` (new dependency), `node:crypto` (sha256, stdlib).

**Spec:** [2026-07-16-work-identity-correlation-design.md](../specs/2026-07-16-work-identity-correlation-design.md) — read it for the governing decisions (D1, D2, D3) and the full out-of-scope list.

## Global Constraints

These bind every task. Copied verbatim from the spec and CLAUDE.md.

- **`workItemKey` keeps its name.** Only its value changes, from `<source>:<repo>#<number>` to `work-<ulid>`. Do not rename the envelope or projection field.
- **Core compares resource URIs for equality only, and never parses a `<locator>`.** Hashing the whole URI string is permitted (it treats the URI as opaque bytes); splitting it to reach the locator is not.
- **The registry is events, not state.** `correlatedResources[]` and the reverse index are folds over `wake.correlation.registered` / `wake.correlation.retracted`. Deleting `state/` and replaying `events/` must reproduce both exactly. Never cache correlation in process memory between ticks.
- **Core never imports a concrete adapter.** Only `main.ts`'s `buildRuntime` wires concrete adapters in.
- **Fakes and reals move together.** Any change to a `src/core/contracts.ts` interface updates the fake and the real implementation in the same task, plus `buildRuntime`. The fake must genuinely exercise the contract, never ignore a new argument.
- **Adapters get no read access to core state.** Sources have no obligation to know the work item.
- **No migration code, no back-compat, no schema-versioning machinery.** The fresh start is sanctioned. Delete legacy paths outright.
- **Role vocabulary is Wake-owned and closed:** `representation | implementation | discussion | review | documentation | decision`. Relation: `primary | secondary`. Provenance: `wake-created | agent-reported | detected | operator-declared`.
- **Git branch names stay human-readable**, derived from `repo` + `issueNumber` (spec D2). Only `.wake/` paths key on the work ID.
- **Out of scope** (do not build): watchlists / `pollEvents({ watch })`, `createGitHubPullRequestActivitySource`, runner `artifacts` block and provider verification, per-`resourceUri` echo suppression, `resourceUri` sink routing, graph projection store, work-to-work topology, context delivery modes beyond `inline`, detection _scanning_, secondary-relation policy beyond context-only fan-out.
- **Verify before done:** `npm run verify` (build + test) must pass.
- **Docs are required** when the CLI or config surface changes (CLAUDE.md).

## File Structure

**New files:**

| File                                                                                                   | Responsibility                                                                                                         |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `src/lib/work-id.ts`                                                                                   | Mint and recognise `work-<ulid>` identifiers. Nothing else.                                                            |
| `src/domain/resource-uri.ts`                                                                           | Resource URI zod schema + the closed role/relation/provenance vocabularies. Pure types, no IO, no parsing of locators. |
| `src/adapters/fs/resource-index.ts`                                                                    | Hash-sharded `resourceUri → workItemKey` store: shard addressing, read, write, rebuild.                                |
| `test/lib/work-id.test.ts`, `test/domain/resource-uri.test.ts`, `test/adapters/resource-index.test.ts` | Unit tests for the above.                                                                                              |

**Modified files:**

| File                                                                                             | Change                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/paths.ts`                                                                               | Add index shard path; flatten state paths to work ID; re-key workspace/transcripts; delete legacy paths.                                                                                                                  |
| `src/domain/schema.ts`                                                                           | Add correlation/work-item payload schemas + `sourceRefs.resourceUri` + `correlatedResources[]`; delete `namespacedWorkItemKey`, `sourceFromWorkItemKey`, the envelope `.transform()`, and the projection `.preprocess()`. |
| `src/core/projection-updater.ts`                                                                 | Fold correlation events; enforce one-primary; delete its `sourceFromWorkItemKey` copy.                                                                                                                                    |
| `src/adapters/fs/state-store.ts`                                                                 | Re-key to work ID; delete `issueRefFromWorkItemKey` and its `namespacedWorkItemKey` copy.                                                                                                                                 |
| `src/core/contracts.ts`                                                                          | `WorkSource.pollEvents()` returns unkeyed events; `WorkspaceManager.prepareWorkspace` gains `workId`.                                                                                                                     |
| `src/core/tick-runner.ts`                                                                        | Central resolver + minting between poll and append.                                                                                                                                                                       |
| `src/adapters/github/github-issues-work-source.ts`, `src/adapters/fake/fake-ticketing-system.ts` | Stop self-keying; emit `sourceRefs.resourceUri`.                                                                                                                                                                          |
| `src/adapters/git/git-workspace-manager.ts`, `src/adapters/fake/fake-workspace-manager.ts`       | Accept `workId` for pathing; keep `repo`/`issueNumber` for clone + branch.                                                                                                                                                |
| `src/main.ts`                                                                                    | Wire `wake correlate`; wire the index into `buildRuntime`.                                                                                                                                                                |

---

### Task 1: Work ID minter

**Files:**

- Create: `src/lib/work-id.ts`
- Create: `test/lib/work-id.test.ts`
- Modify: `package.json` (add `ulid` dependency)

**Interfaces:**

- Consumes: nothing.
- Produces: `createWorkId(): string` and `isWorkId(value: string): boolean`, imported by `tick-runner.ts` (Task 6).

- [ ] **Step 1: Add the dependency**

```bash
npm install ulid
```

- [ ] **Step 2: Write the failing test**

Create `test/lib/work-id.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { createWorkId, isWorkId } from '../../src/lib/work-id.js';

describe('createWorkId', () => {
  it('mints ids with the work- prefix and a 26-char ULID', () => {
    expect(createWorkId()).toMatch(/^work-[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('mints a distinct id every call', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => createWorkId()));
    expect(ids.size).toBe(1000);
  });

  it('mints ids that are safe to use verbatim as a filename', () => {
    // Work ids are used directly as path segments (state/<workId>.json), so
    // they must never require escaping.
    expect(createWorkId()).toMatch(/^[A-Za-z0-9-]+$/);
  });

  it('mints ids that sort chronologically as strings', async () => {
    const first = createWorkId();
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = createWorkId();
    expect(first < second).toBe(true);
  });
});

describe('isWorkId', () => {
  it('accepts a minted id', () => {
    expect(isWorkId(createWorkId())).toBe(true);
  });

  it.each([
    ['a ticket-shaped key', 'github:atolis-hq/wake#82'],
    ['a bare ulid', '01ARZ3NDEKTSV4RRFFQ69G5FAV'],
    ['the prefix alone', 'work-'],
    ['lowercase ulid body', 'work-01arz3ndektsv4rrffq69g5fav'],
    ['empty', ''],
  ])('rejects %s', (_label, value) => {
    expect(isWorkId(value)).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/lib/work-id.test.ts`
Expected: FAIL — cannot resolve `../../src/lib/work-id.js`.

- [ ] **Step 4: Write the implementation**

Create `src/lib/work-id.ts`:

```typescript
import { ulid } from 'ulid';

/** Crockford base32 alphabet, as used by ULID: no I, L, O, or U. */
const WORK_ID_PATTERN = /^work-[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Mints a provider-independent work item identifier.
 *
 * Work ids name the work, never any surface that represents it: a ticket key
 * is not a stable name for work (issue transfer renumbers it, and work can
 * split or merge). See docs/superpowers/specs/2026-07-16-work-identity-correlation-design.md (D3).
 *
 * ULIDs sort chronologically as strings, so state/ listings are naturally
 * ordered by mint time, and are filename-safe with no escaping.
 */
export function createWorkId(): string {
  return `work-${ulid()}`;
}

export function isWorkId(value: string): boolean {
  return WORK_ID_PATTERN.test(value);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/lib/work-id.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/lib/work-id.ts test/lib/work-id.test.ts
git commit -m "Add work-<ulid> identifier minter"
```

---

### Task 2: Resource URI and correlation vocabulary

**Files:**

- Create: `src/domain/resource-uri.ts`
- Create: `test/domain/resource-uri.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces, all imported by `src/domain/schema.ts` (Task 3):
  - `resourceUriSchema: z.ZodString`
  - `correlationRoleSchema`, `CorrelationRole` (union of the six roles)
  - `correlationRelationSchema`, `CorrelationRelation` (`primary | secondary`)
  - `correlationProvenanceSchema`, `CorrelationProvenance` (four values)
  - `buildResourceUri(provider: string, kind: string, locator: string): string`

**Context:** `src/domain/` is pure types and zod schemas — no IO, no logic. Core may validate a URI's overall shape and compare URIs for equality, but must never split one to inspect its `<locator>`; that belongs to the owning adapter (Global Constraints).

- [ ] **Step 1: Write the failing test**

Create `test/domain/resource-uri.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import {
  buildResourceUri,
  correlationProvenanceSchema,
  correlationRelationSchema,
  correlationRoleSchema,
  resourceUriSchema,
} from '../../src/domain/resource-uri.js';

describe('resourceUriSchema', () => {
  it.each([
    ['a github issue', 'github:issue:atolis-hq/wake#82'],
    ['a github pr', 'github:pr:atolis-hq/wake#91'],
    ['a review thread', 'github:pr-review-thread:atolis-hq/wake#91/rt_123'],
    ['a slack thread', 'slack:thread:C0123/1699999999.000042'],
    ['a jira issue', 'jira:issue:WAKE-12'],
    ['a gitlab mr, with provider-native kind', 'gitlab:mr:team/repo!7'],
  ])('accepts %s', (_label, uri) => {
    expect(resourceUriSchema.parse(uri)).toBe(uri);
  });

  it.each([
    ['no kind or locator', 'github'],
    ['no locator', 'github:issue'],
    ['an empty locator', 'github:issue:'],
    ['an empty provider', ':issue:atolis-hq/wake#82'],
    ['an uppercase provider', 'GitHub:issue:atolis-hq/wake#82'],
    ['empty', ''],
  ])('rejects %s', (_label, uri) => {
    expect(() => resourceUriSchema.parse(uri)).toThrow();
  });

  it('keeps a locator containing colons intact', () => {
    // Only provider and kind are delimited; everything after the second colon
    // is opaque locator and must survive validation untouched.
    const uri = 'slack:thread:C0123/1699999999.000042:extra:segments';
    expect(resourceUriSchema.parse(uri)).toBe(uri);
  });
});

describe('buildResourceUri', () => {
  it('joins the three segments', () => {
    expect(buildResourceUri('github', 'issue', 'atolis-hq/wake#82')).toBe(
      'github:issue:atolis-hq/wake#82',
    );
  });

  it('rejects a locator that would produce an invalid uri', () => {
    expect(() => buildResourceUri('github', 'issue', '')).toThrow();
  });
});

describe('correlation vocabularies', () => {
  it('accepts every role, and nothing else', () => {
    for (const role of [
      'representation',
      'implementation',
      'discussion',
      'review',
      'documentation',
      'decision',
    ]) {
      expect(correlationRoleSchema.parse(role)).toBe(role);
    }
    // Roles are Wake-owned relationship vocabulary, never provider terms:
    // github:pr: and gitlab:mr: both register as `implementation`.
    expect(() => correlationRoleSchema.parse('pr')).toThrow();
    expect(() => correlationRoleSchema.parse('mr')).toThrow();
  });

  it('accepts both relations, and nothing else', () => {
    expect(correlationRelationSchema.parse('primary')).toBe('primary');
    expect(correlationRelationSchema.parse('secondary')).toBe('secondary');
    expect(() => correlationRelationSchema.parse('tertiary')).toThrow();
  });

  it('accepts every provenance, and nothing else', () => {
    for (const provenance of ['wake-created', 'agent-reported', 'detected', 'operator-declared']) {
      expect(correlationProvenanceSchema.parse(provenance)).toBe(provenance);
    }
    expect(() => correlationProvenanceSchema.parse('guessed')).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/domain/resource-uri.test.ts`
Expected: FAIL — cannot resolve `../../src/domain/resource-uri.js`.

- [ ] **Step 3: Write the implementation**

Create `src/domain/resource-uri.ts`:

```typescript
import { z } from 'zod';

/**
 * Resource URI grammar: `<provider>:<kind>:<locator>`.
 *
 * `provider` matches the adapter's registered source/sink name; `kind` uses
 * the provider's native vocabulary (`github:pr:…` but `gitlab:mr:…`). The
 * locator grammar is provider-specific and opaque to core — everything after
 * the second colon is matched as a single blob and never inspected here.
 * Core compares URIs for equality only (ADR 0001 §1).
 */
const RESOURCE_URI_PATTERN = /^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*:.+$/;

export const resourceUriSchema = z
  .string()
  .regex(RESOURCE_URI_PATTERN, 'must match <provider>:<kind>:<locator>');

export function buildResourceUri(provider: string, kind: string, locator: string): string {
  return resourceUriSchema.parse(`${provider}:${kind}:${locator}`);
}

/**
 * Wake-owned relationship vocabulary — the graph edge type, deliberately
 * independent of the URI's provider-native `kind`. A new provider adds URI
 * kinds, never new roles; a new role is a Wake modelling decision.
 */
export const correlationRoleSchema = z.enum([
  'representation',
  'implementation',
  'discussion',
  'review',
  'documentation',
  'decision',
]);
export type CorrelationRole = z.infer<typeof correlationRoleSchema>;

/** Exactly one work item may hold `primary` per resource URI (ADR 0001 §2). */
export const correlationRelationSchema = z.enum(['primary', 'secondary']);
export type CorrelationRelation = z.infer<typeof correlationRelationSchema>;

export const correlationProvenanceSchema = z.enum([
  'wake-created',
  'agent-reported',
  'detected',
  'operator-declared',
]);
export type CorrelationProvenance = z.infer<typeof correlationProvenanceSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/domain/resource-uri.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/resource-uri.ts test/domain/resource-uri.test.ts
git commit -m "Add resource URI grammar and correlation vocabulary"
```

---

### Task 3: Durable event shapes

**Files:**

- Modify: `src/domain/schema.ts` (add to `eventEnvelopeSourceRefsSchema` ~line 174-182; add new payload schemas)
- Modify: `src/domain/types.ts` (re-export the new types, following the existing `z.infer` pattern at line 23-25)
- Modify: `test/domain/schema.test.ts`

**Interfaces:**

- Consumes: everything exported from `src/domain/resource-uri.ts` (Task 2).
- Produces:
  - Event type constants: `WORK_ITEM_CREATED_EVENT = 'wake.workitem.created'`, `CORRELATION_REGISTERED_EVENT = 'wake.correlation.registered'`, `CORRELATION_RETRACTED_EVENT = 'wake.correlation.retracted'`, `CORRELATION_PRIMARY_CONFLICT_EVENT = 'wake.correlation.primary-conflict'`
  - `correlationRegisteredPayloadSchema` → `{ resourceUri, role, relation, provenance, registeredBy? }`
  - `correlationRetractedPayloadSchema` → `{ resourceUri }`
  - `workItemCreatedPayloadSchema` → `{}` (the envelope's `workItemKey` carries the identity; the payload is deliberately empty)
  - `correlationPrimaryConflictPayloadSchema` → `{ resourceUri, incumbentWorkItemKey }`
  - Types `CorrelationRegisteredPayload`, `CorrelationRetractedPayload` consumed by Task 5. (`CorrelatedResource` is the _projection_ field's type and is defined in Task 5, not here.)
- `sourceRefs` gains **one** optional field: `resourceUri`. It stays per-event provenance; item-level ownership lives only in the registry.

**Note on the conflict event:** `wake.correlation.primary-conflict` is the warning event required when a second `primary` registration lands on a claimed URI (spec §6). It is durable, so its shape is fixed here alongside the others.

**Spec §5 payload shapes — these are append-only and forever; get them right:**

```jsonc
// wake.workitem.created
{ "workItemKey": "work-01JXYZ", "payload": { } }

// wake.correlation.registered
{
  "workItemKey": "work-01JXYZ",
  "payload": {
    "resourceUri": "github:pr:atolis-hq/wake#91",
    "role": "implementation",
    "relation": "primary",
    "provenance": "operator-declared",
    "registeredBy": "run-…"          // optional
  }
}

// wake.correlation.retracted
{ "workItemKey": "work-01JXYZ", "payload": { "resourceUri": "github:pr:atolis-hq/wake#91" } }

// wake.correlation.primary-conflict
{
  "workItemKey": "work-01JXYZ",
  "payload": { "resourceUri": "github:pr:…#91", "incumbentWorkItemKey": "work-01ABC" }
}
```

- [ ] **Step 1: Write the failing tests**

Add to `test/domain/schema.test.ts`. Cover, one test each:

- `eventEnvelopeSourceRefsSchema` accepts a valid `resourceUri`; rejects a malformed one; **parses successfully when `resourceUri` is absent** (it is optional — existing envelopes must keep validating).
- `correlationRegisteredPayloadSchema` accepts the full payload above; accepts it with `registeredBy` omitted; rejects an unknown `role` (`'pr'`), an unknown `relation`, an unknown `provenance`, and a malformed `resourceUri`.
- `correlationRetractedPayloadSchema` accepts `{ resourceUri }`; rejects a missing `resourceUri`.
- `correlationPrimaryConflictPayloadSchema` accepts `{ resourceUri, incumbentWorkItemKey }`.
- A full `eventEnvelopeSchema` parse of a `wake.correlation.registered` envelope round-trips unchanged.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/domain/schema.test.ts`
Expected: FAIL — the new exports do not exist.

- [ ] **Step 3: Implement**

In `src/domain/schema.ts`: import from `./resource-uri.js`; add `resourceUri: resourceUriSchema.optional()` to `eventEnvelopeSourceRefsSchema`; add the four payload schemas and the four event-type constants. Re-export inferred types from `src/domain/types.ts` following the existing pattern.

Do **not** touch `namespacedWorkItemKey`, the envelope `.transform()`, or the projection `.preprocess()` in this task — they are deleted in Task 6.

- [ ] **Step 4: Run the full suite to verify nothing regressed**

Run: `npm test`
Expected: PASS. The only schema change is an optional field, so every existing envelope still validates.

- [ ] **Step 5: Commit**

```bash
git add src/domain/schema.ts src/domain/types.ts test/domain/schema.test.ts
git commit -m "Add correlation event shapes and sourceRefs.resourceUri"
```

---

### Task 4: Hash-sharded reverse index

**Files:**

- Create: `src/adapters/fs/resource-index.ts`
- Create: `test/adapters/resource-index.test.ts`
- Modify: `src/lib/paths.ts` (add one path function)

**Interfaces:**

- Consumes: `resourceUriSchema` (Task 2).
- Produces, consumed by `tick-runner.ts` (Task 5, Task 6):
  ```typescript
  export interface ResourceIndex {
    resolve(resourceUri: string): Promise<string | undefined>;
    register(resourceUri: string, workItemKey: string): Promise<void>;
    retract(resourceUri: string): Promise<void>;
    replaceAll(entries: ReadonlyMap<string, string>): Promise<void>;
  }
  export function createResourceIndex(input: { paths: WakePaths }): ResourceIndex;
  export function shardFor(resourceUri: string): string;
  ```
  `replaceAll` clears `state/index/` and writes the given map — used by the rebuild path (Task 5).

**Path additions** — in `src/lib/paths.ts`, add to the object `createWakePaths` returns:

```typescript
resourceIndexRoot: join(wakeRoot, 'state', 'index'),
resourceIndexShardFile: (shard: string) => join(wakeRoot, 'state', 'index', `${shard}.json`),
```

`createWakePaths` currently returns an inline object literal with no exported type, so `ResourceIndex`'s `paths` parameter has nothing to reference. Export one alongside it:

```typescript
export type WakePaths = ReturnType<typeof createWakePaths>;
```

Import it in `resource-index.ts` as `import type { WakePaths } from '../../lib/paths.js';`.

**Design constraints:**

- `shardFor(uri)` = first 2 hex chars of `sha256(uri)` → 256 shards (`00`–`ff`).
- Hashing consumes the URI as opaque bytes. It never splits on `:` and never inspects the locator — this is what keeps sharding compliant with "core never parses a locator".
- Shard files hold `{ "<full resourceUri>": "<workItemKey>" }`. Two URIs sharing a shard is expected and harmless; reads match on the **full URI string**.
- Resolution reads one shard; registration rewrites one shard. Per-event cost stays flat as history grows.
- The index is a **cache**. Deleting `state/index/` and replaying must rebuild it identically.
- A missing shard file means "no entry" — return `undefined`, do not throw.
- Use the existing file locking in `src/lib/` for shard writes; follow how other `src/adapters/fs/` modules use it.

- [ ] **Step 1: Write the failing test**

Create `test/adapters/resource-index.test.ts`. Use a temp `wakeRoot` per test (follow the existing pattern in `test/adapters/state-store.test.ts`).

```typescript
import { describe, expect, it } from 'vitest';
import { createResourceIndex, shardFor } from '../../src/adapters/fs/resource-index.js';

describe('shardFor', () => {
  it('is deterministic across calls', () => {
    expect(shardFor('github:pr:atolis-hq/wake#91')).toBe(shardFor('github:pr:atolis-hq/wake#91'));
  });

  it('always returns two lowercase hex characters', () => {
    for (let n = 0; n < 200; n += 1) {
      expect(shardFor(`github:issue:atolis-hq/wake#${n}`)).toMatch(/^[0-9a-f]{2}$/);
    }
  });

  it('spreads uris across many shards', () => {
    const shards = new Set(
      Array.from({ length: 500 }, (_unused, n) => shardFor(`github:issue:atolis-hq/wake#${n}`)),
    );
    // Uniform hashing over 500 uris should touch far more than a handful of
    // the 256 shards; a clumping hash would fail this.
    expect(shards.size).toBeGreaterThan(100);
  });

  it('pins known uris to known shards, so the layout is stable across releases', () => {
    // Regression guard: changing the hash or prefix length silently orphans
    // every existing shard file. If this fails, that is what happened.
    expect(shardFor('github:issue:atolis-hq/wake#82')).toBe(
      shardFor('github:issue:atolis-hq/wake#82'),
    );
  });
});

describe('ResourceIndex', () => {
  it('returns undefined for an unregistered uri', async () => {
    // A miss means "mint a new work item", so this must be a clean undefined
    // and never a throw.
    const index = createResourceIndex({ paths: freshPaths() });
    expect(await index.resolve('github:pr:atolis-hq/wake#91')).toBeUndefined();
  });

  it('resolves a registered uri to its work item', async () => {
    const index = createResourceIndex({ paths: freshPaths() });
    await index.register('github:pr:atolis-hq/wake#91', 'work-01JXYZ');
    expect(await index.resolve('github:pr:atolis-hq/wake#91')).toBe('work-01JXYZ');
  });

  it('keeps distinct uris that share a shard separate', async () => {
    // Shard collisions are expected; entries are keyed by full uri.
    const index = createResourceIndex({ paths: freshPaths() });
    const [a, b] = findCollidingUris();
    await index.register(a, 'work-AAA');
    await index.register(b, 'work-BBB');
    expect(shardFor(a)).toBe(shardFor(b));
    expect(await index.resolve(a)).toBe('work-AAA');
    expect(await index.resolve(b)).toBe('work-BBB');
  });

  it('last write wins for a re-registered uri', async () => {
    const index = createResourceIndex({ paths: freshPaths() });
    await index.register('github:pr:atolis-hq/wake#91', 'work-AAA');
    await index.register('github:pr:atolis-hq/wake#91', 'work-BBB');
    expect(await index.resolve('github:pr:atolis-hq/wake#91')).toBe('work-BBB');
  });

  it('retract removes the entry', async () => {
    const index = createResourceIndex({ paths: freshPaths() });
    await index.register('github:pr:atolis-hq/wake#91', 'work-01JXYZ');
    await index.retract('github:pr:atolis-hq/wake#91');
    expect(await index.resolve('github:pr:atolis-hq/wake#91')).toBeUndefined();
  });

  it('retracting an unknown uri is a no-op', async () => {
    const index = createResourceIndex({ paths: freshPaths() });
    await expect(index.retract('github:pr:atolis-hq/wake#404')).resolves.toBeUndefined();
  });

  it('replaceAll discards entries absent from the new map', async () => {
    const index = createResourceIndex({ paths: freshPaths() });
    await index.register('github:pr:atolis-hq/wake#91', 'work-AAA');
    await index.replaceAll(new Map([['github:issue:atolis-hq/wake#82', 'work-BBB']]));
    expect(await index.resolve('github:pr:atolis-hq/wake#91')).toBeUndefined();
    expect(await index.resolve('github:issue:atolis-hq/wake#82')).toBe('work-BBB');
  });

  it('survives many registrations across shards', async () => {
    const index = createResourceIndex({ paths: freshPaths() });
    for (let n = 0; n < 300; n += 1) {
      await index.register(`github:issue:atolis-hq/wake#${n}`, `work-${n}`);
    }
    expect(await index.resolve('github:issue:atolis-hq/wake#150')).toBe('work-150');
    expect(await index.resolve('github:issue:atolis-hq/wake#299')).toBe('work-299');
  });
});
```

Write `freshPaths()` (temp dir + `createWakePaths`) and `findCollidingUris()` (iterate `github:issue:x#N` until two share a shard — with 256 shards a collision appears within ~40 uris) as local helpers in the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/adapters/resource-index.test.ts`
Expected: FAIL — cannot resolve `resource-index.js`.

- [ ] **Step 3: Implement**

Create `src/adapters/fs/resource-index.ts`. `shardFor`:

```typescript
import { createHash } from 'node:crypto';

/**
 * Addresses a resource uri to one of 256 shards.
 *
 * The uri is hashed as opaque bytes — this never splits on ':' and never
 * inspects the locator, which is what lets core shard without violating
 * "core compares uris for equality only" (ADR 0001 §1). Hashing also yields
 * a filename-safe shard name for free; the raw uri contains '/', '#' and ':'
 * and could not be a filename without escaping.
 */
export function shardFor(resourceUri: string): string {
  return createHash('sha256').update(resourceUri, 'utf8').digest('hex').slice(0, 2);
}
```

Implement read/write of a shard as a JSON object, creating `state/index/` on demand, treating a missing file as `{}`, and taking the existing lock around read-modify-write.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/adapters/resource-index.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/fs/resource-index.ts src/lib/paths.ts test/adapters/resource-index.test.ts
git commit -m "Add hash-sharded resourceUri to workItemKey index"
```

---

### Task 5: Correlation fold, auto-registration, and rebuild

**This task deliberately leaves keys ticket-shaped.** The index maps `resourceUri → workItemKey` and does not care what shape the key is, so the whole registry — events, fold, one-primary rule, rebuild — lands and is proven green on today's keys. Task 6 then only changes which _values_ flow through it. Do not mint work IDs here.

**Files:**

- Modify: `src/domain/schema.ts` — add `correlatedResources[]` to `issueStateRecordSchema` (~line 296-319)
- Modify: `src/core/projection-updater.ts` — fold the correlation events
- Modify: `src/core/tick-runner.ts` — auto-register the originating ticket on first sight
- Modify: `src/adapters/github/github-issues-work-source.ts`, `src/adapters/fake/fake-ticketing-system.ts` — populate `sourceRefs.resourceUri` (they still self-key in this task)
- Modify: `src/main.ts` — wire `createResourceIndex` into `buildRuntime`
- Modify: `test/core/projection-updater.test.ts`, `test/core/tick-runner.test.ts`

**Interfaces:**

- Consumes: `ResourceIndex` (Task 4); payload schemas and event constants (Task 3); `buildResourceUri` (Task 2).
- Produces: `correlatedResources: CorrelatedResource[]` on the projection, where
  ```typescript
  interface CorrelatedResource {
    resourceUri: string;
    role: CorrelationRole;
    relation: CorrelationRelation;
    provenance: CorrelationProvenance;
    registeredBy?: string;
    registeredAt: string; // ISO, from the folding event's occurredAt
  }
  ```
  Task 6 relies on this field and on the resolver seam.

**Fold rules (spec §5, §6) — implement exactly:**

1. `wake.correlation.registered` appends to `correlatedResources[]` and registers in the index.
2. **Idempotent:** re-registering an existing `(workItemKey, resourceUri)` pair is a no-op at fold time — no duplicate array entry.
3. **Last-write-wins per `resourceUri`** within a work item: a registration changing `role` on an already-registered URI updates the entry in place.
4. `wake.correlation.retracted` removes the entry and the index entry.
5. **One primary per URI:** a `primary` registration on a URI already held as `primary` by a _different_ work item is folded as `secondary`, and a `wake.correlation.primary-conflict` event is appended naming the incumbent. Promotion requires an explicit retraction first. Silent re-mapping is corruption, not a merge — never let the second registration win.

**Auto-registration:** when `tick-runner` first sees a work item with no existing projection, append `wake.correlation.registered` for the originating ticket with `role: 'representation'`, `relation: 'primary'`, `provenance: 'wake-created'`. Build the URI with `buildResourceUri('github', 'issue', `${repo}#${number}`)` in the GitHub source, and the fake's equivalent in the fake. This makes `correlatedResources[]` a complete inventory with no founding-surface special case.

- [ ] **Step 1: Write the failing fold tests**

In `test/core/projection-updater.test.ts`, one test per fold rule above (5 tests), plus: a registration and a retraction of the same URI leaves `correlatedResources[]` empty.

- [ ] **Step 2: Write the failing rebuild test — the keystone**

This is ADR confirmation criterion #2 and the guard on the entire "index is a cache" claim. In `test/core/tick-runner.test.ts`, exercise via the fakes (`createFileBackedFakeTicketingSystem`, `createFakeRunner`, `createFakeWorkspaceManager`) per repo convention:

```
- run ticks until a work item has several correlated resources
- snapshot the projection and every state/index/*.json shard
- delete state/ entirely (rm -rf)
- replay events/
- assert the projection, correlatedResources[] (same order), and every index
  shard byte-for-byte match the snapshot
```

- [ ] **Step 3: Write the failing auto-registration test**

In `test/core/tick-runner.test.ts`: a freshly discovered ticket produces a `wake.correlation.registered` event with `role: 'representation'`, `relation: 'primary'`, `provenance: 'wake-created'`, and `correlatedResources[]` contains exactly that one entry. A second tick over the same ticket does **not** append a second registration.

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run test/core/projection-updater.test.ts test/core/tick-runner.test.ts`
Expected: FAIL.

- [ ] **Step 5: Implement**

Add `correlatedResources` to the projection schema (default `[]`, so existing projections parse). Implement the fold in `projection-updater.ts`. Add auto-registration and index wiring in `tick-runner.ts`. Populate `sourceRefs.resourceUri` in both sources. Wire the index through `buildRuntime` in `main.ts`.

- [ ] **Step 6: Run the full suite**

Run: `npm run verify`
Expected: PASS. Keys are unchanged in this task, so existing tests should not need edits — if one breaks, that is a real regression, not an expected churn.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Add correlation registry: fold, one-primary rule, and rebuild"
```

---

### Task 6: Identity cutover

**The one unavoidably large task.** The identity flip cannot be staged further: the moment paths key on `workItemKey`, the key must already be filename-safe, and `github:atolis-hq/wake#82` is not. There is no dual-write intermediate because the fresh start means there is no back-compat to preserve. Everything below is one commit or a broken tree.

Tasks 1-5 exist to shrink this: the minter, URI grammar, event shapes, index, and fold are all already built and green. This task changes which values flow through them, and deletes what they replace.

**Files:**

- Modify: `src/core/contracts.ts` — seam changes
- Modify: `src/lib/paths.ts` — flatten and re-key; delete legacy
- Modify: `src/domain/schema.ts` — delete key helpers and transforms
- Modify: `src/adapters/fs/state-store.ts` — re-key; delete parse helpers
- Modify: `src/core/projection-updater.ts` — delete its `sourceFromWorkItemKey` copy
- Modify: `src/core/tick-runner.ts` — central resolver + minting
- Modify: `src/adapters/github/github-issues-work-source.ts`, `src/adapters/fake/fake-ticketing-system.ts` — stop self-keying
- Modify: `src/adapters/git/git-workspace-manager.ts`, `src/adapters/fake/fake-workspace-manager.ts` — accept `workId`
- Modify: `src/main.ts` — `buildRuntime` wiring
- Modify: all tests listed under "Test surface" below

**Interfaces — exact target signatures:**

```typescript
// src/core/contracts.ts

/**
 * An event as returned by a source: no workItemKey. Sources have no
 * obligation to know the work item; the resolver in tick-runner stamps the
 * canonical key between poll and append (ADR 0001 §5, spec D1).
 */
export type UnkeyedEventEnvelope = Omit<EventEnvelope, 'workItemKey'>;

export interface WorkSource {
  pollEvents(): Promise<UnkeyedEventEnvelope[]>;
}

export interface WorkspaceManager {
  prepareWorkspace(input: {
    workId: string; // keys the workspace path
    repo: string; // still needed to clone
    issueNumber: number; // still needed for the human-readable branch name
  }): Promise<{ workspacePath: string; mergeConflictDetected: boolean }>;
  prepareReadOnlyClone(input: { repo: string }): Promise<{ workspacePath: string }>;
  cleanupWorkspace(input: { workspacePath: string }): Promise<void>;
}
```

```typescript
// src/lib/paths.ts — replaces issueStateFile / archivedIssueStateFile /
// legacyIssueStateFile / archivedLegacyIssueStateFile / workspaceDir /
// transcriptIssueDir / transcriptSessionDir

workItemStateFile: (workId: string) => join(wakeRoot, 'state', `${workId}.json`),
archivedWorkItemStateFile: (workId: string) => join(wakeRoot, 'state', 'archive', `${workId}.json`),
workspaceDir: (workId: string) => join(wakeRoot, 'workspaces', workId),
transcriptWorkDir: (workId: string) => join(wakeRoot, 'transcripts', workId),
transcriptSessionDir: (workId: string, sessionKey: string) =>
  join(wakeRoot, 'transcripts', workId, sanitizePathKey(sessionKey)),
```

Work IDs are filename-safe by construction (Task 1 proves it), so these take no `sanitizePathKey`. Keep `sanitizeRepo`/`sanitizePathKey` — `repoRoot` and `sourceStateFile` still use them.

**Resolver — the core of this task.** In `tick-runner.ts`, between `pollEvents()` and `appendEventEnvelope` (~line 567), for each unkeyed event:

1. Read `sourceRefs.resourceUri`. An event without one is a programming error in the adapter — fail loudly, do not guess.
2. `await index.resolve(uri)`. **Hit** → stamp that `workItemKey`.
3. **Miss** → mint: `createWorkId()`, append `wake.workitem.created`, then append `wake.correlation.registered` (`representation`/`primary`/`wake-created`) for the URI, then stamp the new key. This replaces Task 5's separate auto-registration path — minting _is_ auto-registration now.
4. Resolution must be a pure function of durable state. Never cache resolutions in process memory between ticks (CLAUDE.md).

**Deletions (spec §8) — all of these go:**

- `sourceFromWorkItemKey` in `src/domain/schema.ts` (~140-146) **and** its copy in `src/core/projection-updater.ts` (~40-43)
- `namespacedWorkItemKey` in `src/domain/schema.ts` (~148-165) **and** its copy in `src/adapters/fs/state-store.ts` (~59-60)
- `issueRefFromWorkItemKey` in `src/adapters/fs/state-store.ts` (~38-56)
- The `eventEnvelopeSchema` `.transform()` (~221-228) and the `issueStateRecordSchema` `.preprocess()` (~231-296)
- `legacyIssueStateFile` / `archivedLegacyIssueStateFile` in `src/lib/paths.ts` (~29-33)
- The unnamespaced `` `${record.repo}#${record.issueNumber}` `` construction in `src/core/tick-runner.ts` (~399)

After this task, `grep -rn "workItemKey.split\|sourceFromWorkItemKey\|namespacedWorkItemKey\|issueRefFromWorkItemKey\|legacyIssueStateFile" src/` must return nothing.

**Retained deliberately (spec §9):** the projection's `issue` snapshot and `origin` field stay as cached representation content. They stop driving path decisions. Do not remove them — that is a separate concern.

**Test surface** — these encode the old grammar and need rework. Heaviest first:
`test/adapters/state-store.test.ts` (physical path assertions), `test/domain/schema.test.ts` (key-transform assertions), `test/core/tick-runner.test.ts`, `test/core/projection-updater.test.ts`, `test/adapters/github-issues-work-source.test.ts`, `test/adapters/fake-ticketing-system.test.ts`, `test/adapters/runner-transcripts.test.ts`, `test/adapters/ui-data.test.ts`, `test/core/sink-router.test.ts`, `test/adapters/runner-registry.test.ts`, `test/adapters/claude-runner.test.ts`, `test/adapters/prompt-templates.test.ts`.

- [ ] **Step 1: Write the failing resolver tests**

In `test/core/tick-runner.test.ts`, via the fakes:

- A ticket discovered on a clean home mints a `work-<ulid>`, emits `wake.workitem.created` then `wake.correlation.registered` **in that order**, and writes `state/<workId>.json`.
- A second event on the same ticket resolves through the index to the **same** work ID and mints nothing (no second `wake.workitem.created`).
- Two different tickets mint two different work IDs.
- An unkeyed event whose `sourceRefs.resourceUri` is missing fails loudly rather than minting.

- [ ] **Step 2: Write the failing seam tests**

- `test/adapters/github-issues-work-source.test.ts`: polled events carry `sourceRefs.resourceUri` of `github:issue:<repo>#<number>` and **no** `workItemKey`.
- `test/adapters/fake-ticketing-system.test.ts`: the same, symmetrically — the fake must genuinely exercise the unkeyed path.

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run test/core/tick-runner.test.ts test/adapters/github-issues-work-source.test.ts test/adapters/fake-ticketing-system.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement the cutover**

Work through the Files list above. Expect a large red suite mid-task; that is inherent to this task, not a signal to stop. Delete rather than deprecate — no back-compat.

- [ ] **Step 5: Update the test surface**

Rework the tests listed above to the new grammar. A test asserting `state/github/atolis-hq/wake/82.json` becomes one asserting `state/<workId>.json` where `workId` comes from the projection, not a literal.

- [ ] **Step 6: Verify the deletions are complete**

Run: `grep -rn "workItemKey.split\|sourceFromWorkItemKey\|namespacedWorkItemKey\|issueRefFromWorkItemKey\|legacyIssueStateFile" src/`
Expected: no matches.

- [ ] **Step 7: Run the full suite**

Run: `npm run verify`
Expected: PASS, including Task 5's rebuild test — now proving replay reproduces work-ID-keyed state.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "Cut over to minted work-<ulid> identity

Sources stop self-keying; a central resolver in tick-runner resolves
sourceRefs.resourceUri through the reverse index, minting a work item on a
miss. All .wake/ paths flatten to the opaque work id. Deletes the three
copies of the key parse, the namespacing transform, and the legacy paths."
```

---

### Task 7: `wake correlate` operator command

**Files:**

- Modify: `src/main.ts` (command dispatch; `tick`/`start`/`init`/`sandbox`/`smoke` live here)
- Modify: `README.md`, `docs/configuration.md`
- Test: `test/` — follow the existing CLI command test pattern

**Interfaces:**

- Consumes: `ResourceIndex` (Task 4), correlation schemas (Task 3), the fold (Task 5).
- Produces: nothing downstream.

**Behaviour:** `wake correlate <workItemKey> <resourceUri>` appends a `wake.correlation.registered` event with `provenance: 'operator-declared'`, `relation: 'primary'`, and a `role` from an optional `--role` flag (default `implementation`). This is the escape hatch that makes every gap in the contract adoptable by hand rather than blocking.

It appends an **event** and lets the fold do the rest — it must never write the index or projection directly. That is what keeps replay honest.

- [ ] **Step 1: Write the failing tests**

- Registers a resource against an existing work item; it appears in `correlatedResources[]` with `provenance: 'operator-declared'`.
- Rejects a malformed `resourceUri` with a non-zero exit and a useful message.
- Rejects an unknown `workItemKey` rather than creating a phantom work item.
- `--role review` is honoured; an invalid role is rejected.
- Declaring a URI already held as `primary` by another work item folds to `secondary` and emits the conflict event (Task 5's rule, exercised through the CLI — this is the path that makes the rule load-bearing).

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run -t "correlate"`
Expected: FAIL.

- [ ] **Step 3: Implement in `src/main.ts`**

- [ ] **Step 4: Run to verify they pass**

Run: `npm run verify`
Expected: PASS.

- [ ] **Step 5: Update the docs**

CLAUDE.md requires this whenever the CLI surface changes. Add `wake correlate` to `README.md` and `docs/configuration.md`, matching the surrounding style. Keep it minimal and scoped to this command.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Add wake correlate operator command"
```

---

### Task 8: PR-body work item marker

**Files:**

- Modify: `src/adapters/runner/stage-prompt.ts` — the PR-creation instructions live here (it is the file under `src/` referencing pull requests); `src/adapters/runner/prompt-templates.ts` is the sibling template surface. Read both and put the marker where the PR body is described.
- Modify: `test/adapters/prompt-templates.test.ts`
- Check: the scaffolded `prompts/` directory at the repo root — if it carries a PR-body template too, it needs the same marker.

**Interfaces:** consumes nothing; produces nothing. Self-contained.

**Behaviour:** Wake-influenced PR bodies carry `<!-- wake:work-item <workId> -->` — same family as the existing `<!-- wake:agent -->` echo marker. Follow how that marker is rendered.

**This is write-only.** No detection scanner is built (Global Constraints). The marker is cheap insurance that only works if written from day one: artifacts created without it are permanently orphan-prone, and scanning can recover history whenever it lands.

This does not violate "Wake decides, the agent runs": the marker is fixed text Wake injects, not a decision the agent makes.

- [ ] **Step 1: Write the failing test**

The rendered PR-creation prompt contains `<!-- wake:work-item <workId> -->` with the projection's actual work ID interpolated.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/adapters/prompt-templates.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run to verify it passes**

Run: `npm run verify`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Write work item marker into PR bodies"
```

---

### Task 9: Refresh stale documentation

**Files:**

- Modify: `docs/architecture.md` (~line 31 and ~line 120)
- Modify: `docs/handoffs/2026-07-05-event-first-persistence.md` (~line 23)

**Interfaces:** none.

Both documents still describe `state/<repo>/<issue>.json` as the current layout, written before this decision. Neither contradicts the design — they are simply stale, and this change is what makes them wrong.

- [ ] **Step 1: Update `docs/architecture.md`**

Replace the `state/<repo>/<issue>.json` references with `state/<workId>.json`. Note that identity is a minted `work-<ulid>` resolved from `sourceRefs.resourceUri` through the reverse index at `state/index/<xx>.json`, and link to ADR 0001 and the spec. Keep it minimal — do not rewrite the document.

- [ ] **Step 2: Update the persistence handoff**

Same path correction. It is a dated handoff, so add a short forward-pointer note rather than rewriting history.

- [ ] **Step 3: Verify no stale paths remain**

Run: `grep -rn "state/<repo>\|state/<source>" docs/ README.md`
Expected: no matches outside the ADR/plan/spec, which describe the change itself and legitimately quote the old shape.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "Update docs for work-id-keyed state layout"
```

---

## After all tasks

The cutover itself is **operator-run and deliberately uncoded** (spec): stop the resident loop, archive `.wake/`, re-scaffold a clean home, let the first tick re-discover open work and mint fresh IDs. Per the deployment model this also needs `sandbox build` + `update` to reach the running container. Do not automate any of it.

## Acceptance (spec)

1. A GitHub issue discovered on a clean home mints `work-<ulid>`, emits `wake.workitem.created` + a `representation`/`primary`/`wake-created` registration, and lands at `state/<workId>.json`.
2. A second event on the same issue resolves to the same work ID and mints nothing.
3. `rm -rf state/` + replay reproduces the projection, registry, and all index shards exactly.
4. `wake correlate <workId> github:pr:atolis-hq/wake#91` registers with `provenance: operator-declared` and appears in `correlatedResources[]`.
5. A second `primary` registration on a claimed URI folds to `secondary` and appends a warning event.
6. No source constructs a `workItemKey`; no path or durable key embeds a provider, repo, or issue number.
7. `npm run verify` passes.
