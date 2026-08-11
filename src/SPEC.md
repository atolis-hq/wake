# src — Specification Index

This is the entry point into every target behavioural specification under
`src/`. Start at [SPECIFICATION.md](SPECIFICATION.md) for the standard
these documents follow, then use the table below to reach any module's
`SPEC.md`. Each module page links on to its own component `.spec.md` files —
this index does not link across modules or duplicate that detail.

| Module | Purpose |
| --- | --- |
| [kernel](kernel/SPEC.md) | Stable universal primitives and ports every other module builds on. |
| [work](work/SPEC.md) | Durable WorkItem identity and lifecycle. |
| [resources](resources/SPEC.md) | Canonical Resource identity, capabilities, and correlation to Work. |
| [activities](activities/SPEC.md) | The Activity contract and built-in specialist SDLC capabilities (agent execution, PR approve/merge). |
| [orchestration](orchestration/SPEC.md) | Configured workflow interpretation and durable workflow instances. |
| [execution](execution/SPEC.md) | Runs, dispatch, runners, workspaces, supervision, and recovery. |
| [integrations](integrations/SPEC.md) | Provider adapters, inbound translation, delivery, and reconciliation. |
| [control-plane](control-plane/SPEC.md) | System-level bounded coordination through `advanceOnce`. |
| [persistence](persistence/SPEC.md) | Filesystem implementations of Kernel's storage ports. |
| [bootstrap](bootstrap/SPEC.md) | Configuration loading, dependency composition, and process startup. |
| [surfaces](surfaces/SPEC.md) | CLI, API, and UI presentation over public applications and views. |
