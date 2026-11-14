# Work-detail runs and tabs design

## Goal

Make the runs table in a work-item detail show each run's workflow and stage, matching the global Runs page, and style the Overview/Events controls as the application's green-underlined navigation.

## Data flow

The work-detail application already performs the server-side relationship lookup `work item -> workflow instances -> runs`. It will apply the existing execution presenter enrichment to each collected run: load its workflow instance and attach `workflowName` and `currentStage` as `stage`. This keeps the detail view a single request and makes its `RunResponse` shape identical to `/api/v1/runs`.

The `withWorkflowContext` helper currently belongs to the execution surface application. Move or expose the helper from a shared bootstrap module so both the execution collection/detail application and the work-detail application use exactly the same enrichment rule.

## UI

The work detail continues to render the shared `runColumns`, so no work-item-specific table column logic is added. Its existing tab buttons will be styled locally to match the primary navigation: dark-green background, muted idle text, green active text, and a green underline for the selected tab. Buttons remain buttons and retain their current state and accessibility behavior.

## Tests

Extend the work-detail UI test fixture with a run workflow and stage. Assert that the Runs table displays both values, proving the response decoder and shared run columns render them. Add an application-level regression test that verifies work-detail runs are enriched with their workflow context, while retaining the existing execution application behavior.

## Scope

Do not add a work-item filter to `/api/v1/runs`, client-side joining, or a second runs request. Do not change the work-item's ownership model: runs remain execution projections associated through workflow instances.
