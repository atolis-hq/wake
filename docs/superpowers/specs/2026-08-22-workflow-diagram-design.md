# Workflow diagram design

## Goal

Show a fixed visualisation of a workflow definition in the control-plane UI.
On a work item's Overview tab, overlay the resolved workflow instance and its
runs. On Configuration, show each currently configured workflow without run
or instance state.

The diagram explains the definition first and the instance state second. It
does not replace the detailed run table.

## Scope and delivery order

The first implementation slice is the production-quality final web component,
rendered in situ on the Work Overview and Configuration screens from
representative mocked workflow-diagram JSON. It is not a disposable wireframe:
the card hierarchy, states, labels, layout, responsive behaviour, accessibility,
and visual styling are the final design before any API contract, presenter, or
persistence wiring is added.

Once the prototype is approved, the backend adds the same diagram model to
the work-detail read and a read-only endpoint for the current configured
workflows. The web component then consumes those responses without changing
its rendering model.

Out of scope: editing workflows, drag and drop, pan and zoom, selection,
minimaps, historical workflow-definition versions, and a graph canvas.

## Diagram model

The API exposes a semantic `WorkflowDiagram` view, rather than raw root
configuration or positioned graph data. The web client computes coordinates.

It contains:

- workflow identity: name and entry stage; a work-item diagram also carries
  the resolved workflow-definition fingerprint;
- one stage node per configured stage;
- directed transitions, labelled by the configured outcome, signal, or
  resource event;
- child definitions under their owning stage: the primary activity, applicable
  watches, watch gates, and resource/event reactors;
- optional instance overlay for status, last outcome, active work, and metrics.

The definition is compiled before it becomes this view. No surface derives
workflow semantics from the raw root configuration.

## Card hierarchy and accounting

A stage card is an aggregate container. It displays its status and totals for
all runs attributed to that stage: run count, duration, token usage, and cost.

Inside it, child cards are deduplicated by definition identity:

- one primary-activity card;
- one card for each applicable watch or watch gate;
- one card for each resource/event reactor.

Activity and watch cards display their own run count, duration, token usage,
cost, last outcome, and existing active-run treatment. A watch that has
spawned several child workflow instances is still one card, aggregated across
those instances. Reactors are not agent runs, so their cards show existing
status only and omit agent-run metrics.

The intended accounting pattern is, for example, a `refine` stage with four
runs and two minutes total, containing `refine: 1m30s`, `review: 1m`, and
`notify: 30s` child summaries. The child sums are a breakdown of the stage
total, not additional work.

## Layout and responsiveness

Use ELK for deterministic fixed layout. The web UI renders positioned HTML
cards and an SVG edge layer; it does not use an interactive graph/canvas
library.

Desktop layout is left-to-right, with the entry stage at the left. Mobile
recomputes the same graph top-to-bottom. Every stage remains in the mobile
graph, but each stage's child-card area is collapsible. Only stages currently
active in the instance start expanded; all other stages start collapsed.

Edges show outcome or event labels where text improves comprehension, and use
a small visual indicator for approval/watch-style transitions where that is
clearer. Branches, retries, and loops remain visible as labelled directed
edges.

## Surface integration

`GET /work-items/:workItemKey` gains `orchestration.diagram`, resolved from
the primary workflow instance's fingerprinted definition and overlaid with the
primary instance, watch-child instances, and their runs.

A new read-only system workflow-diagrams endpoint returns exactly one diagram
for each current configured workflow name. It does not expose historical
fingerprints or instance data. Configuration renders these diagrams using the
same component and retains the redacted effective configuration separately.

## Validation

Unit tests cover transformation of stages, labelled transitions, loops,
watches, watch gates, resource transitions, aggregation, deduplication, and
status overlays. API tests lock both response shapes and current-definition
selection. Web tests cover work and configuration variants, desktop/mobile
layout inputs, collapsible stages, active-stage defaults, and accessible card
and edge labels.

The final visual component, backed by mocked JSON, is reviewed in place before
backend work starts.
