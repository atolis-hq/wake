# Workflow selector — Component Specification

## Type, purpose, and scope

Policy/process. This component is a pure function matching a candidate
WorkItem's tags, kind, and adapter facts against a list of configured
workflow selectors, and returning the matching selector's target workflow
name — or a fallback when none match. It supplies the matching function
only; deciding *that* a workflow should start for a WorkItem, and invoking
this function at the right moment, is a caller's responsibility outside
Orchestration.

## Responsibilities and boundaries

This component owns compiling raw selector configuration into a validated,
branded form and the pure candidate-to-workflow-name match itself. It does
not own the candidate facts it matches against — those are supplied by
whichever module admits a WorkItem — and it does not itself start a
workflow or call anything in Orchestration's own command surface.

## Core policies, invariants, and behaviours

- Compiling a selector list MUST brand each selector's target `workflow`
  name through the same identifier validation every other compiled
  workflow name uses; `match` and `matchMode` are carried through
  unchanged.
- A candidate MUST be checked against selectors in their configured order;
  the first selector whose `match` is satisfied wins. No selector matching
  MUST fall back to the caller-supplied fallback workflow name.
- A selector's `match` has up to three independent facets — `tags`, `kind`,
  `adapter` — each an optional list of required values. A facet with no
  configured values is satisfied vacuously, regardless of the candidate; a
  selector therefore only constrains the facets it actually declares.
- Within a declared facet, the selector's own `matchMode` decides whether
  **all** of the facet's required values must be present on the candidate,
  or **any** one of them; `kind` and `adapter` are single optional strings
  on the candidate, compared as a one-element list.
- All declared facets of a selector MUST be satisfied together for that
  selector to match; `matchMode` governs how each facet's own required
  values are checked, not whether facets combine with AND or OR — every
  declared facet is always required.

## Conceptual schema

**WorkflowCandidate** — the facts a caller supplies about a WorkItem being
routed; not a durable entity, and carries no workflow name of its own.

| Field | Type | Description |
| --- | --- | --- |
| `tags` | list of string | The WorkItem's current tags. |
| `kind` | optional string | The WorkItem's kind, if the admitting adapter supplies one. |
| `adapter` | optional string | The adapter that admitted the WorkItem, if known. |

**CompiledWorkflowSelector** — the validated, ordered form of one
configured selector.

| Field | Type | Description |
| --- | --- | --- |
| `match` | `{ tags?, kind?, adapter? }` | The facets this selector constrains; unlisted facets match vacuously. |
| `matchMode` | closed vocabulary: `any` / `all` | How a declared facet's required values are checked against the candidate. |
| `workflow` | WorkflowDefinition name | The workflow this selector routes to when matched. |

## Dependencies and system role

- Workflow compiler (shares the identifier validation this component reuses
  to brand a selector's `workflow` name) — a compiled selector's target name
  is validated the same way any compiled workflow's own name is.
- Kernel — the `MatchMode` vocabulary and its any/all matching helper this
  component's facet checks are built on.
- Integrations (depends on this component) — the module specification names
  Integrations as the caller that selects a workflow for newly admitted
  work through this port; Orchestration's own command surface never invokes
  it.

## Decisions, exclusions, and deferred capability

- Selector precedence is strictly configuration order with first-match-wins;
  there is no weighting, specificity scoring, or conflict detection between
  selectors that could both match the same candidate.
- Configuration is the only routing authority: nothing in this component
  inspects a WorkItem beyond the `WorkflowCandidate` facts a caller chooses
  to supply, and it never proposes a workflow the caller did not already
  configure.
