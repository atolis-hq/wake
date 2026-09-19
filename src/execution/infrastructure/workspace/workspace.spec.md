# Workspace adapters — Component Specification

---
asOf: 2b630543ef6ff897ef137eacaa7a833fa5cc3f29
---

## Type, purpose, and scope

Adapter. Workspace adapters prepare and release the isolated working
directory a Run may execute in, translating a `WorkspaceRequest` into a
concrete filesystem path and back into a releasable `WorkspaceLease`.

## Responsibilities and boundaries

Workspace adapters own acquiring a directory for a requested `read-only` or
`branch` workspace and releasing it once the Run that acquired it is done.
They do not decide whether a Run needs a workspace at all, and they do not
locate the repository resource a workspace is acquired from — the Execution
service resolves the mode and the resource before calling `acquire`. The
real adapter delegates resolving a clone locator (a URL or local path) to an
injected resolver, then performs the actual `git clone` into the managed
directory itself, via an injected git command runner; it does not implement
branch-checkout or any git operation beyond a plain clone.

The real adapter also owns a narrow crash-orphan recovery capability. It
records durable ownership before cloning, retains WorkItem-scoped checkouts
between Runs, then lets the composed pre-dispatch recovery pass reclaim only
workspaces whose WorkItem and journal owner are demonstrably safe to remove.
It does not decide Run ambiguity or introduce a background cleanup service.

## Core policies, invariants, and behaviours

- `acquire` MUST only ever be called for `read-only` or `branch` mode; the
  contract's request type does not admit `none` — a Run with workspace mode
  `none` never reaches a workspace adapter at all.
- `acquire` MUST receive the owning attempt's `AbortSignal`. The real adapter
  MUST propagate it through clone-locator resolution, Git clone/switch
  processes, and the configured prepare-hook process, and MUST re-check it
  around filesystem operations that cannot consume a signal directly.
- The real adapter MUST derive the workspace's directory name
  deterministically from the requesting `workItemId` and the repository
  resource's resolved clone locator (lower-cased, non-alphanumeric runs
  collapsed to a single hyphen, leading/trailing hyphens stripped) — it
  does not incorporate the Run's own id or attempt number into the name.
  Two acquisitions for the same work item and repository therefore resolve
  to the same directory path.
- The real adapter MUST clone the resolved locator into the resolved
  directory via its injected git runner only when that directory does not
  already contain a `.git` subdirectory; when one is already present, the
  acquisition reuses the existing clone without re-cloning. Read-only
  acquisition resets tracked files before preparation, preserving ignored
  dependency state. If the resource has a revision it fetches and checks out
  that exact revision and fails if Git cannot do so; otherwise it resets to
  the initial clone's existing `HEAD` without a remote refresh.
- The real adapter MUST hold an exclusive, cancellation-aware workspace lock
  from marker update through checkout reset, preparation, and lease release.
  Competing Runs wait; they never share the writable checkout.
- Before it invokes `git clone`, the real adapter MUST write a strict JSON
  ownership marker under `<workspace-root>/.wake-workspace-ownership`. The
  marker contains `runId`, `workItemId`, `repositoryResourceId`, `mode`,
  `workspaceId`, and the absolute `path`; it is the sole durable authority
  for crash-orphan reclamation. Its owner Run is already durably `starting`;
  this marker is not a substitute for a missing pre-Run record.
- Releasing a lease ends only that Run's exclusive use. Both branch and
  read-only trees and their ownership markers remain retained while the
  WorkItem is open, including after failed or cancelled Runs. Recovery owns
  physical deletion once the WorkItem is closed, cancelled, or deleted.
- Recovery MUST delete only a valid marker-owned workspace whose path is a
  strict descendant of the canonical managed root and whose Run view is
  terminal or absent. It MUST retain Starting, Started, and Ambiguous Runs, unmarked
  directories, malformed markers, marker-directory paths, lexical or
  canonical out-of-root paths (including links/junctions), and any ownership
  shape it cannot validate.
- Recovery samples the existing dispatch-pause state between markers and
  stops when paused. A failed deletion is reported while later markers still
  receive a recovery attempt; repeating the pass is idempotent. There is no
  age-based cleanup, resident reaper, or workspace-recovery configuration.
- A released workspace's lease MUST NOT be reused; its directory is retained
  for a later, separately locked acquisition rather than returned to a pool.
- The fake adapter MUST record every request it receives and always return
  a fixed path with a lease whose `release()` performs no filesystem
  effect, so tests can assert on what was requested without touching disk.

## Conceptual schema

**WorkspaceRequest**

| Field | Type | Description |
| --- | --- | --- |
| `mode` | closed vocabulary: `read-only` / `branch` | The requested isolation level; `none` never reaches this contract. |
| `runId` | Run identity (owned by Execution) | Identifies the durable owner written into the marker before clone. |
| `signal` | AbortSignal | Cancels preparation when the Run or Execution service is shutting down. |
| `workItemId` | WorkItem identity (owned by Work) | Keys the real adapter's directory name. |
| `repositoryResource` | Resource view (owned by Resources) | The repository the workspace is prepared from; its resolved clone locator also keys the directory name. |

**WorkspaceLease**

| Field | Type | Description |
| --- | --- | --- |
| `workspaceId` | string | Identifies the acquired workspace; for the real adapter, the same as the directory name. |
| `path` | string | The absolute directory a Run executes in. |
| `mode` | closed vocabulary: `read-only` / `branch` | Echoed from the request. |
| `release` | function | Releases the workspace; for the real adapter, deletes `path` entirely. |

**Workspace ownership marker**

| Field | Description |
| --- | --- |
| `runId` | Run whose terminal/absent state authorizes recovery. |
| `workItemId` / `repositoryResourceId` | Immutable acquisition identity retained for audit and strict validation. |
| `mode` | The requested `read-only` or `branch` isolation mode. |
| `workspaceId` / `path` | Deterministic directory identity and its absolute, managed path. |

## Dependencies and system role

- `node:fs/promises` — the external effect boundary the real adapter
  checks for an existing clone and deletes a workspace directory through.
- An injected git command runner (the real adapter depends on, defaulting
  to spawning the real `git` executable) — the external effect boundary
  the real adapter clones a repository through.
- An injected repository-clone resolver (the real adapter depends on) —
  resolves the clone locator (a URL or local path) the git runner clones
  from; this component itself performs the clone.
- Execution service (depends on) — the only caller, invoked when an
  attempt's requested workspace mode is not `none`, and responsible for
  locating the resource passed as `repositoryResource` (a `Repository`-kind
  resource, or an `Issue`/`PullRequest`-kind resource as a fallback) and
  releasing the returned lease once the attempt concludes.
- Resources (depends on) — supplies the `ResourceView` a workspace is
  acquired from.

## Decisions, exclusions, and deferred capability

- There is no workspace pooling, reuse tracking, or per-attempt isolation
  beyond the deterministic work-item/repository-keyed path described above;
  concurrent attempts against the same work item and repository share one
  physical directory.
- A read-only workspace with a Resource revision is refreshed to that exact
  revision on every acquisition; without one it remains pinned to its initial
  clone revision. The opaque prepare hook runs on every acquisition and owns
  dependency caching and invalidation.
- Crash cleanup is intentionally narrow: it reclaims only valid, marker-owned
  terminal or never-started workspaces during the composed recovery pass. It
  never deletes an active/ambiguous/unknown workspace, nor uses directory
  age, an operator setting, or a resident timer to broaden that decision.
