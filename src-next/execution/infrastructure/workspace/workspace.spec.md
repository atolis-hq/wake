# Workspace adapters — Component Specification

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
real adapter does not itself perform repository cloning or branch
mechanics; it delegates resolving a local clone source to an injected
resolver and only manages the resulting directory.

## Core policies, invariants, and behaviours

- `acquire` MUST only ever be called for `read-only` or `branch` mode; the
  contract's request type does not admit `none` — a Run with workspace mode
  `none` never reaches a workspace adapter at all.
- The real adapter MUST derive the workspace's directory name
  deterministically from the requesting `workItemId` and the repository
  resource's resolved clone locator (lower-cased, non-alphanumeric runs
  collapsed to a single hyphen, leading/trailing hyphens stripped) — it
  does not incorporate the Run's own id or attempt number into the name.
  Two acquisitions for the same work item and repository therefore resolve
  to the same directory path; the second acquisition's directory creation
  is idempotent (an already-existing directory is reused, not recreated or
  isolated from the first).
- The real adapter MUST create the resolved directory if it does not
  already exist, and MUST release it by deleting the entire directory tree,
  regardless of which mode (`read-only` or `branch`) it was acquired under.
- A released workspace's lease MUST NOT be reused; `release()` deletes the
  directory rather than returning it to a pool.
- The fake adapter MUST record every request it receives and always return
  a fixed path with a lease whose `release()` performs no filesystem
  effect, so tests can assert on what was requested without touching disk.

## Conceptual schema

**WorkspaceRequest**

| Field | Type | Description |
| --- | --- | --- |
| `mode` | closed vocabulary: `read-only` / `branch` | The requested isolation level; `none` never reaches this contract. |
| `workItemId` | WorkItem identity (owned by Work) | Keys the real adapter's directory name. |
| `repositoryResource` | Resource view (owned by Resources) | The repository the workspace is prepared from; its resolved clone locator also keys the directory name. |

**WorkspaceLease**

| Field | Type | Description |
| --- | --- | --- |
| `workspaceId` | string | Identifies the acquired workspace; for the real adapter, the same as the directory name. |
| `path` | string | The absolute directory a Run executes in. |
| `mode` | closed vocabulary: `read-only` / `branch` | Echoed from the request. |
| `release` | function | Releases the workspace; for the real adapter, deletes `path` entirely. |

## Dependencies and system role

- `node:fs/promises` — the external effect boundary the real adapter
  creates and deletes directories through.
- An injected repository-clone resolver (the real adapter depends on) —
  the actual source of a usable local clone; this component only computes
  and manages the directory the clone is expected to live in.
- Execution service (depends on) — the only caller, invoked when an
  attempt's requested workspace mode is not `none`, and responsible for
  locating the `Repository`-kind resource and releasing the returned lease
  once the attempt concludes.
- Resources (depends on) — supplies the `ResourceView` a workspace is
  acquired from.

## Decisions, exclusions, and deferred capability

- There is no workspace pooling, reuse tracking, or per-attempt isolation
  beyond the deterministic work-item/repository-keyed path described above;
  concurrent attempts against the same work item and repository share one
  physical directory.
- There is no crash-cleanup path: a workspace acquired by a process that
  crashes mid-attempt is only released by that same attempt's own `finally`
  handling in the Execution service; nothing in this component or Recovery
  reclaims an orphaned workspace directory.
