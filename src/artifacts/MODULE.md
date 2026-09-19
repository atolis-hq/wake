# artifacts

## Purpose
Durable, agent-produced work-item artifacts and their authorized access.
## Owns
Artifact identifiers, revision facts, projections, storage ports, access policy, and Wake MCP tools.
## Does not own
Workflow transitions, runner invocation, provider publication, Git workspaces, or UI delivery.
## Invariants
Artifact bytes are separate from Git workspaces; only the owning producer may write; journal facts are authoritative.
## Public contracts
`index.ts` is the only public entry.
## Configuration
Uses the strict root `artifacts` storage policy.
## Relations and events
Owns `artifact.` events and `artifact-work-item` streams.
## Failure and recovery
Staged revisions are durable before publication; unreachable bytes are collectible.
Run-scoped MCP credentials expire and are revoked when their activity returns.
## Extension rules
Concrete stores stay in infrastructure and Bootstrap composes them.
The MCP transport is a Surface concern; this module owns tool semantics only.
