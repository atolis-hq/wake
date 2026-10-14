# artifacts

## Purpose
Durable, agent-produced work-item artifacts, operator standing instructions for named context scopes, and their authorized access.
## Owns
Artifact identifiers, revision facts, projections, storage ports, access policy, and Wake MCP tools.
## Does not own
Workflow transitions, runner invocation, provider publication, Git workspaces, or UI delivery.
## Invariants
Artifact bytes are separate from Git workspaces; only the owning producer may write agent artifacts; journal facts are authoritative.
## Public contracts
`index.ts` is the only public entry.
## Configuration
Uses the strict root `artifacts` storage policy.
## Relations and events
Owns `artifact.` events and `artifact-work-item` streams, plus `artifact-context.` events and
`artifact-context` streams (named read-only sharing scopes, current-memory pointer, delegation grants).
Trusted hosts enroll members and publish; MCP only reads shared references.
Producer writes may opt a revision into their credential's trusted context;
acceptance and successful invocation completion authorize publication.
Memory conflicts are durable rejected-publication receipts. Named scopes reserve
`delegation:` for directional grants.
## Failure and recovery
Staged revisions are durable before publication; unreachable bytes are collectible.
Run-scoped MCP credentials expire and are revoked when their activity returns.
## Extension rules
Concrete stores stay in infrastructure and Bootstrap composes them.
The MCP transport is a Surface concern; this module owns tool semantics only.

Operator instructions use a separate operator-provenance context fact and the existing byte store. Trusted operator commands compare the loaded revision before appending; MCP exposes only read-only run snapshots. Names and paths supplied by agents never establish operator provenance. The configured maxWriteBytes limit applies to operator documents.

The fixed name instructions.md is reserved against agent artifact commands and listings. Operator creation is lazy and independent of membership. The host-only instructions catalogue reads the latest revision per scope from the Artifacts-owned operator-instructions projection registered in Bootstrap; it is not a scope registry. Removing or renaming configuration never deletes a document.
