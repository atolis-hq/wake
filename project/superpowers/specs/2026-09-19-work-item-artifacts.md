# Work-item artifacts

## Status

Proposed implementation specification. This document defines the first
artifact capability to be implemented on `feat/work-item-artifacts`.

## Outcome

Wake retains agent-produced work products as durable, work-item-scoped
artifacts. A later agent can discover and read the current relevant artifacts
without receiving an entire external conversation or relying on a Git
workspace. A human can inspect those artifacts in Wake.

This is not provider state, Git state, or a mandatory workflow handoff
mechanism.

## Scope

The MVP provides:

- a provider-neutral `artifacts` domain module;
- append-only artifact revision and tombstone facts, with rebuildable views;
- a filesystem byte-store below `.wake/artifacts/<work-item-id>/`;
- owner-scoped arbitrary relative paths and opaque binary content;
- a run-bound Wake MCP capability for list, read, write, text patch, and
  delete; and
- read-only artifact presentation from a work item in Wake.

The MVP does not implement workflow rewind/branch semantics, provider-side
artifact publication, Git storage, human artifact authorship, or a generic
workflow configuration language for handoffs.

## Ownership and visibility

An artifact is identified by a stable producer namespace and a normalized
relative path. A producer namespace is the workflow-instance node/stage that
executed the activity, not a particular Run. A retry or later re-entry of that
same producer may create a new revision. Independent watch/child instances
have distinct producer namespaces.

Only the producer namespace may create, revise, or tombstone its artifacts.
There is at most one active writer activation per producer namespace. There is
no cross-stage mutation or append operation.

An activation may list and read the latest accepted, non-tombstoned artifact
revision from every causally upstream producer and from its own producer
namespace. It cannot read sibling or downstream outputs. The first MVP uses
the current orchestration upstream relation only; it does not infer a new
lineage when a completed workflow is rewound in a future feature.

The start prompt includes an artifact manifest, not artifact content. Each
manifest entry contains enough metadata to decide whether to fetch it: owner,
path, media type when known, byte length, digest, and revision. The agent reads
content explicitly through Wake.

## Revisions and durable publication

Writing an already-existing owner/path creates a new revision. Deletion creates
a durable tombstone. Normal manifests and the normal UI show only the latest
non-tombstoned revision. Prior revisions and tombstones remain retained for
audit but are not returned as agent inputs.

MCP writes first create durable, Run-and-Activation-bound staged revisions.
They are visible only to that running activation. The execution path records
all staged revisions before submitting the activity outcome. A revision is
published when, and only when, Orchestration durably accepts its producing
activation's outcome. This is a derived visibility rule, rather than a
cross-stream filesystem move or distributed transaction.

A failed, cancelled, rejected, or superseded activity never publishes its
staged revisions. Its bytes may remain temporarily as unreachable garbage and
are eligible for collection. If Wake crashes after staging but before outcome
acceptance, recovery retains the same rule. If Wake crashes after acceptance,
the recorded staged revision is already available for projection.

## Module boundary

`artifacts` owns artifact identifiers, stream definitions, `artifact.` event
types, decoders, event factories, views, projection, repository, and the
application service that authorizes artifact operations. It depends on Kernel,
Eventing, and Work identifiers only. It does not import runner, provider,
workflow, HTTP, or UI infrastructure.

Execution owns activity lifecycle and supplies a verified run/activation
session to the artifact application service. Orchestration remains the owner
of outcome acceptance and transitions. Artifact visibility reads accepted
outcome facts; neither artifacts nor execution decides a transition.

Bootstrap composes the artifact filesystem adapter, service, projections, MCP
endpoint, runner decorations, and surfaces. Surfaces only call public artifact
applications and views.

## Storage

`resolveWakePaths` gains `artifactsRoot`, rooted at `.wake/artifacts`.
The filesystem adapter must keep its internal revision, temporary, and
content-addressed layout private. Public APIs must never expose local paths.
Artifact bytes are addressed by durable artifact revision metadata and exposed
through Wake URLs, not `file:` URLs.

The default policy is a maximum 25 MiB per write and 250 MiB of retained data
per work item. These are instance-wide artifact-storage settings, not
provider-, file-type-, workflow-, or step-specific settings. No allowlist of
file types is imposed. The UI may safely preview supported text and image
formats; all other types remain downloadable.

## Wake MCP

Wake exposes one trusted MCP server intended to grow into the agent-facing Wake
control-plane interface. Artifacts are its first tools; a separate artifact
MCP server must not be introduced.

The initial tools are:

- `wake.artifacts.list` — returns the invocation's visible manifest;
- `wake.artifacts.read` — returns an authorized artifact revision, supporting
  byte or text ranges;
- `wake.artifacts.write` — stages arbitrary bytes at an owner path;
- `wake.artifacts.patch` — atomically applies a text patch to an authorized
  text artifact; and
- `wake.artifacts.delete` — stages a tombstone for an owner path.

Every request uses a short-lived credential bound to one execution Run and
activation. The service enforces owner-write and upstream-read scope; runner
configuration is never trusted as an authorization boundary. A running
activation can read its own staged writes, while no other activation can see
them before publication. Agents do not declare artifact output in their final
response because tool calls are authoritative.

An artifact-capable runner must support trusted ephemeral Wake-tool injection.
The adapter preference order is direct per-run injection, an isolated generated
agent configuration home passed to the process, then an explicitly
operator-installed global Wake MCP using the same run-bound credential.
Repository MCP configuration is not a fallback. Runners that cannot meet this
contract are ineligible before dispatch; Wake must not silently run without the
capability.

## External and human surfaces

Wake's work-item view gains an Artifacts tab grouped by producer. It lists the
current artifact revision and supplies an authorized viewer or download. Human
users cannot create, change, or delete artifacts in the MVP.

Artifact links are stable Wake addresses, not bearer credentials, and always
enforce the ordinary work-item authorization policy. Existing provider run
comments should link their Wake header to the canonical work-item route; Wake
does not maintain provider comments or issue descriptions as an artifact
index.

## Delivery order and acceptance

1. Introduce the `artifacts` module, vocabulary, event decoder, repository,
   fold/projection, artifact-store port, filesystem adapter, storage policy,
   and focused unit tests.
2. Compose the service and projections in Bootstrap; expose a read-only
   work-item artifact application/API and UI tab.
3. Bind staging/publication to Execution and accepted Orchestration outcomes;
   prove cancellation, failure, crash recovery, retry, revision, and tombstone
   behavior.
4. Add the run-bound Wake MCP server and fake deterministic adapter.
5. Add runner-specific ephemeral configuration injection only after a
   compatibility spike proves it for each supported runner.

Before enabling a real runner, the compatibility spike must prove fresh and
resumed sessions, no repository/global configuration trust, run-token
isolation, cancellation teardown, arbitrary binary transfer, and no approval
deadlock. Every delivery stage needs focused unit coverage plus composed
integration evidence. The finished feature must pass the relevant API/web
tests and the normal architecture and verification gates.
