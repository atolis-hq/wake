# Workflow Diagram Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render a final, responsive workflow-definition diagram in the Work Overview and Configuration views, then replace its mocked JSON source with a dedicated diagram API.

**Architecture:** A shared web component renders semantic stage and transition data as positioned HTML cards with an SVG edge layer. ELK provides fixed coordinates only: left-to-right on desktop and top-to-bottom on mobile, with no graph-canvas interactions. The first milestone drives the final component from fixtures; the second adds an Orchestration-owned diagram view, surface presenter, and the single `/api/v1/workflow-diagrams` collection endpoint.

**Tech Stack:** React 19, TypeScript, CSS Modules, TanStack Query, Vitest/Testing Library, ELK (`elkjs`), Wake API contracts and compiled Orchestration definitions.

---

## File structure

| File | Responsibility |
| --- | --- |
| `src/surfaces/web/src/features/workflow-diagram/model.ts` | Web-only semantic diagram types, fixture factory, and display helpers for the visual-first milestone. |
| `src/surfaces/web/src/features/workflow-diagram/workflow-diagram.tsx` | Shared static graph, stage card, child card, edge label, and collapse controls. |
| `src/surfaces/web/src/features/workflow-diagram/workflow-diagram.module.css` | Desktop and mobile graph/card styling. |
| `src/surfaces/web/src/features/workflow-diagram/layout.ts` | ELK input conversion and deterministic layout calculation. |
| `src/surfaces/web/test/workflow-diagram.test.tsx` | Component behaviour, status presentation, card aggregation, and mobile collapse tests. |
| `src/surfaces/web/src/features/work/work.tsx` | Hosts the mocked diagram above the existing run table, then later queries the endpoint. |
| `src/surfaces/web/src/features/configuration/configuration.tsx` | Hosts the mocked/current-definition diagrams above redacted JSON. |
| `src/orchestration/application/workflow-diagram.ts` | Pure compiled-definition plus instance/run overlay transformation. |
| `src/surfaces/api/contracts/workflow-diagram.ts` | Public transport contract for the collection item and graph payload. |
| `src/surfaces/api/presenters/workflow-diagram.ts` | Surface-only presenter from the orchestration view to transport values. |
| `src/bootstrap/surface-api-workflow-diagram-applications.ts` | Composition-root reader that resolves current definitions or a work-item fingerprint and gathers overlays. |
| `src/surfaces/api/routes/{applications.ts,read.ts,workflow-diagram.ts}` | API application capability and `GET /api/v1/workflow-diagrams` route declaration. |
| `src/surfaces/web/src/api/{client.ts,decoders.ts,query-keys.ts}` | Web request, strict response decoder, and query key. |
| `src/surfaces/api/api-application.spec.md` | Current-state contract documentation for the new collection route. |

### Task 1: Add the fixed-layout dependency

**Files:**
- Modify: `src/surfaces/web/package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Add the failing import-only build proof**

Create `src/surfaces/web/src/features/workflow-diagram/layout.ts` containing:

```ts
import ELK from 'elkjs/lib/elk.bundled.js';

export const elk = new ELK();
```

- [ ] **Step 2: Run the web build to verify the dependency is absent**

Run: `npm run build:web`

Expected: FAIL with a TypeScript or Vite resolution error for `elkjs/lib/elk.bundled.js`.

- [ ] **Step 3: Install ELK in the web workspace**

Run: `npm install --workspace @atolis-hq/wake-web elkjs`

Expected: `src/surfaces/web/package.json` lists `elkjs` under `dependencies` and the lockfile changes.

- [ ] **Step 4: Run the web build to verify the import resolves**

Run: `npm run build:web`

Expected: PASS.

- [ ] **Step 5: Commit the dependency**

```bash
git add src/surfaces/web/package.json package-lock.json src/surfaces/web/src/features/workflow-diagram/layout.ts
git commit -m "build: add ELK workflow layout dependency"
```

### Task 2: Define the final visual component’s mocked semantic data

**Files:**
- Create: `src/surfaces/web/src/features/workflow-diagram/model.ts`
- Test: `src/surfaces/web/test/workflow-diagram.test.tsx`

- [ ] **Step 1: Write the failing fixture contract test**

```tsx
import { describe, expect, it } from 'vitest';
import { mockWorkItemWorkflowDiagram } from '../src/features/workflow-diagram/model.js';

it('models stage aggregates separately from primary, watch, and reactor children', () => {
  const refine = mockWorkItemWorkflowDiagram.stages.find((stage) => stage.id === 'refine');
  expect(refine).toMatchObject({ runCount: 4, totalDurationMs: 120_000 });
  expect(refine?.children.map((child) => child.kind)).toEqual(['activity', 'watch', 'reactor']);
  expect(refine?.children.map((child) => child.runCount)).toEqual([1, 2, undefined]);
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npx vitest run src/surfaces/web/test/workflow-diagram.test.tsx`

Expected: FAIL because `model.ts` does not exist.

- [ ] **Step 3: Add the semantic model and representative fixtures**

Define these exported types in `model.ts`:

```ts
export type WorkflowDiagramStatus = 'active' | 'waiting' | 'blocked' | 'completed';
export type WorkflowDiagramChildKind = 'activity' | 'watch' | 'watch-gate' | 'reactor';
export interface WorkflowDiagramChild { readonly id: string; readonly kind: WorkflowDiagramChildKind; readonly label: string; readonly status?: WorkflowDiagramStatus; readonly lastOutcome?: string; readonly activeRuns?: readonly { readonly activity: string; readonly runnerName?: string; readonly startedAt: string }[]; readonly runCount?: number; readonly totalDurationMs?: number; readonly totalTokens?: number; readonly inputTokens?: number; readonly outputTokens?: number; readonly cacheReadTokens?: number; readonly cacheWriteTokens?: number; readonly totalCostUsd?: number; }
export interface WorkflowDiagramStage { readonly id: string; readonly label: string; readonly status?: WorkflowDiagramStatus; readonly lastOutcome?: string; readonly runCount?: number; readonly totalDurationMs?: number; readonly totalTokens?: number; readonly inputTokens?: number; readonly outputTokens?: number; readonly cacheReadTokens?: number; readonly cacheWriteTokens?: number; readonly totalCostUsd?: number; readonly children: readonly WorkflowDiagramChild[]; }
export interface WorkflowDiagramTransition { readonly id: string; readonly source: string; readonly target: string; readonly label: string; readonly kind: 'outcome' | 'await' | 'watch-gate' | 'resource-transition'; }
export interface WorkflowDiagram { readonly workflowName: string; readonly entryStageId: string; readonly stages: readonly WorkflowDiagramStage[]; readonly transitions: readonly WorkflowDiagramTransition[]; }
```

Export `mockWorkItemWorkflowDiagram` with `refine`, `review`, and `deploy` stages. Give `refine` the requested four-run/two-minute aggregate and activity/watch/reactor children. Leave unreached stages without a status rather than introducing a new status vocabulary. Export `mockConfiguredWorkflowDiagrams` as definition-only variants for two workflow names.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `npx vitest run src/surfaces/web/test/workflow-diagram.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit the mocked final-design input**

```bash
git add src/surfaces/web/src/features/workflow-diagram/model.ts src/surfaces/web/test/workflow-diagram.test.tsx
git commit -m "test: define workflow diagram visual fixtures"
```

### Task 3: Implement ELK layout and the final static diagram component

**Files:**
- Modify: `src/surfaces/web/src/features/workflow-diagram/layout.ts`
- Create: `src/surfaces/web/src/features/workflow-diagram/workflow-diagram.tsx`
- Create: `src/surfaces/web/src/features/workflow-diagram/workflow-diagram.module.css`
- Modify: `src/surfaces/web/test/workflow-diagram.test.tsx`

- [ ] **Step 1: Write the failing rendering and collapse tests**

```tsx
it('renders stage totals, child breakdowns, and labelled transitions', async () => {
  render(<WorkflowDiagramView diagram={mockWorkItemWorkflowDiagram} />);
  expect(await screen.findByRole('group', { name: 'Stage refine' })).toHaveTextContent('4 runs');
  expect(screen.getByText('refine')).toBeTruthy();
  expect(screen.getByText('review')).toBeTruthy();
  expect(screen.getByText('pr merged')).toBeTruthy();
});

it('starts only active stages expanded and lets an operator expand another stage', async () => {
  const user = userEvent.setup();
  render(<WorkflowDiagramView diagram={mockWorkItemWorkflowDiagram} />);
  expect(screen.getByRole('button', { name: 'Collapse refine details' })).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByRole('button', { name: 'Expand deploy details' })).toHaveAttribute('aria-expanded', 'false');
  await user.click(screen.getByRole('button', { name: 'Expand deploy details' }));
  expect(screen.getByRole('button', { name: 'Collapse deploy details' })).toHaveAttribute('aria-expanded', 'true');
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npx vitest run src/surfaces/web/test/workflow-diagram.test.tsx`

Expected: FAIL because `WorkflowDiagramView` does not exist.

- [ ] **Step 3: Implement deterministic layout conversion**

Implement `layoutWorkflowDiagram(diagram, direction)` in `layout.ts`. Use an ELK layered graph with `elk.direction` set to `RIGHT` for desktop and `DOWN` for mobile. Each stage becomes a node with a stable width and estimated height; each transition becomes an ELK edge. Return immutable node bounds and edge section points so the view never positions nodes from raw configuration order.

```ts
export type WorkflowDiagramDirection = 'desktop' | 'mobile';
export interface PositionedWorkflowDiagram { readonly width: number; readonly height: number; readonly nodes: ReadonlyMap<string, { readonly x: number; readonly y: number; readonly width: number; readonly height: number }>; readonly edges: ReadonlyMap<string, readonly { readonly x: number; readonly y: number }[]>; }
export async function layoutWorkflowDiagram(diagram: WorkflowDiagram, direction: WorkflowDiagramDirection): Promise<PositionedWorkflowDiagram> { /* translate ELK output and reject missing node/edge geometry */ }
```

- [ ] **Step 4: Implement the final view and styling**

`WorkflowDiagramView` accepts a `WorkflowDiagram` and renders a labelled `<section>`. It observes `'(max-width: 42rem)'`, calls `layoutWorkflowDiagram` with the corresponding direction, renders cards in an absolutely positioned graph surface, and renders the edge paths/labels in a sibling `<svg aria-hidden="true">`.

Implement `StageCard` with a button that controls a child-card region. Initialise expanded state from `stage.status === 'active'`; do not collapse the stage title, totals, or status. Reuse `Chip`, `OutcomeChip`, `TokenUsage`, `fmtDuration`, and `fmtCost` for all established UI vocabulary and number formatting. A reactor child omits `TokenUsage`, duration, cost, and run count whenever those values are absent.

The CSS must use left-to-right positioned layout above `42rem`; below it, preserve the ELK top-to-bottom ordering, set graph width to its computed mobile width, and allow vertical document scrolling only. Do not add cursor-grab styles, pointer handlers, transform state, minimap, or zoom controls.

- [ ] **Step 5: Run focused web tests and build**

Run: `npx vitest run src/surfaces/web/test/workflow-diagram.test.tsx && npm run build:web`

Expected: PASS.

- [ ] **Step 6: Commit the final visual component**

```bash
git add src/surfaces/web/src/features/workflow-diagram src/surfaces/web/test/workflow-diagram.test.tsx
git commit -m "feat: render static workflow diagrams"
```

### Task 4: Place the final component in both UI locations using mocked JSON

**Files:**
- Modify: `src/surfaces/web/src/features/work/work.tsx`
- Modify: `src/surfaces/web/src/features/configuration/configuration.tsx`
- Modify: `src/surfaces/web/test/work-detail.test.tsx`
- Modify: `src/surfaces/web/test/configuration.test.tsx`

- [ ] **Step 1: Write failing in-situ visual placement tests**

```tsx
it('shows the workflow diagram above the detailed run list on Overview', async () => {
  render(<MemoryRouter initialEntries={['/work/wk_a']}><App client={detailClient()} /></MemoryRouter>);
  const diagram = await screen.findByRole('region', { name: 'Workflow delivery' });
  const runs = screen.getByRole('table', { name: 'Runs' });
  expect(diagram.compareDocumentPosition(runs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('shows each mocked configured workflow diagram above the effective configuration', async () => {
  render(<MemoryRouter initialEntries={['/configuration']}><App client={client()} /></MemoryRouter>);
  expect(await screen.findByRole('region', { name: 'Workflow delivery' })).toBeTruthy();
  expect(screen.getAllByRole('region', { name: /Workflow / }).length).toBe(2);
});
```

- [ ] **Step 2: Run the two focused tests to verify they fail**

Run: `npx vitest run src/surfaces/web/test/work-detail.test.tsx src/surfaces/web/test/configuration.test.tsx`

Expected: FAIL because neither page renders `WorkflowDiagramView`.

- [ ] **Step 3: Wire fixtures into the existing pages without network calls**

In `WorkDetail`, render `<WorkflowDiagramView diagram={mockWorkItemWorkflowDiagram} />` as the first content in `overviewMain`, directly before the existing Runs empty state/table. In `ConfigurationPage`, map `mockConfiguredWorkflowDiagrams` to the same component before the redacted configuration panel. Do not add a query, route, decoder, or API contract in this task.

- [ ] **Step 4: Run focused tests and visual QA**

Run: `npx vitest run src/surfaces/web/test/work-detail.test.tsx src/surfaces/web/test/configuration.test.tsx && npm run build:web`

Expected: PASS.

Start the UI against a local Wake home, inspect Work Overview and Configuration at desktop and a viewport below `42rem`, and refine CSS until the cards, labels, routing, and collapsed state match the approved design.

- [ ] **Step 5: Commit and pause for visual review**

```bash
git add src/surfaces/web/src/features/work/work.tsx src/surfaces/web/src/features/configuration/configuration.tsx src/surfaces/web/test/work-detail.test.tsx src/surfaces/web/test/configuration.test.tsx
git commit -m "feat: show mocked workflow diagrams in situ"
```

Stop after this commit and obtain user approval of the final visual design before beginning Task 5.

### Task 5: Create the orchestration-owned semantic diagram view

**Files:**
- Create: `src/orchestration/application/workflow-diagram.ts`
- Create: `test/unit/orchestration/workflow-diagram.test.ts`
- Modify: `src/orchestration/index.ts`

- [ ] **Step 1: Write failing transformation tests**

```ts
it('emits labelled outcome, watch-gate, await, and resource-transition edges from a compiled definition', () => {
  const diagram = buildWorkflowDiagram({ definition, instance: undefined, childInstances: [], runs: [] });
  expect(diagram.transitions.map((edge) => edge.kind)).toEqual(expect.arrayContaining(['outcome', 'watch-gate', 'resource-transition']));
  expect(diagram.stages.find((stage) => stage.id === 'refine')?.children.map((child) => child.kind)).toEqual(['activity', 'watch', 'watch-gate', 'reactor']);
});

it('deduplicates spawned watch instances and aggregates all stage runs', () => {
  const diagram = buildWorkflowDiagram({ definition, instance, childInstances: [firstWatch, retryWatch], runs });
  expect(diagram.stages.find((stage) => stage.id === 'refine')).toMatchObject({ runCount: 4, totalDurationMs: 120_000 });
  expect(diagram.stages.find((stage) => stage.id === 'refine')?.children.filter((child) => child.kind === 'watch')).toHaveLength(1);
});
```

- [ ] **Step 2: Run the focused unit test to verify it fails**

Run: `npx vitest run test/unit/orchestration/workflow-diagram.test.ts`

Expected: FAIL because `buildWorkflowDiagram` does not exist.

- [ ] **Step 3: Implement the pure Orchestration projection**

Create public, serialisable diagram view types and `buildWorkflowDiagram(input)`. Its input is a `CompiledWorkflow`, optional primary `WorkflowInstanceView`, child `WorkflowInstanceView[]`, and enriched run statistics supplied by the caller. It must:

- create exactly one primary activity child per stage;
- attach every `watch.while.stages` watch child to its applicable stages;
- attach route watch gates and resource transitions to their source stage;
- create one labelled edge per compiled outcome route, await, watch-gate rejection path, and resource transition;
- aggregate a stage over all runs whose `stage` matches it, including follow-ons and supplemental activities;
- aggregate a watch child over all runs belonging to child instances with the same `watchId`;
- expose existing workflow/run statuses and last outcomes without creating new status vocabulary;
- omit run metrics for reactors.

Export only the public types and builder from `src/orchestration/index.ts`.

- [ ] **Step 4: Run the focused unit test to verify it passes**

Run: `npx vitest run test/unit/orchestration/workflow-diagram.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the domain view**

```bash
git add src/orchestration/application/workflow-diagram.ts src/orchestration/index.ts test/unit/orchestration/workflow-diagram.test.ts
git commit -m "feat: derive workflow diagram view"
```

### Task 6: Expose one workflow-diagrams collection endpoint

**Files:**
- Create: `src/surfaces/api/contracts/workflow-diagram.ts`
- Create: `src/surfaces/api/presenters/workflow-diagram.ts`
- Create: `src/bootstrap/surface-api-workflow-diagram-applications.ts`
- Modify: `src/surfaces/api/contracts/index.ts`
- Modify: `src/surfaces/api/routes/applications.ts`
- Modify: `src/surfaces/api/routes/read.ts`
- Modify: `src/surfaces/api/routes/workflow-diagram.ts`
- Modify: `src/bootstrap/surface-api-applications.ts`
- Modify: `src/surfaces/index.ts`
- Modify: `src/surfaces/api/api-application.spec.md`
- Test: `test/integration/surfaces/api-routes.test.ts`

- [ ] **Step 1: Write failing route contract tests**

```ts
it('lists only current configured definition-only workflow diagrams', async () => {
  const response = await dispatcher.dispatch('GET', '/api/v1/workflow-diagrams');
  expect(response?.status).toBe(200);
  expect(JSON.parse(response!.body).items).toEqual([expect.objectContaining({ workflowName: 'delivery', stages: expect.any(Array) })]);
});

it('returns a one-item instance-overlaid collection for workItemKey', async () => {
  const response = await dispatcher.dispatch('GET', '/api/v1/workflow-diagrams?workItemKey=wk_a');
  expect(JSON.parse(response!.body).items[0]).toEqual(expect.objectContaining({ workflowDefinitionFingerprint: expect.any(String) }));
});
```

- [ ] **Step 2: Run the focused API test to verify it fails**

Run: `npx vitest run test/integration/surfaces/api-routes.test.ts -t "workflow diagrams"`

Expected: FAIL with a 404 because the route is absent.

- [ ] **Step 3: Add the public transport contract and presenter**

Mirror the domain semantic diagram as `WorkflowDiagramResponse`, with `workflowName`, optional `workflowDefinitionFingerprint`, `entryStageId`, `stages`, and `transitions`. Use existing transport vocabulary for closed status values. The presenter only maps the public orchestration view; it never reads config, projections, or runs.

- [ ] **Step 4: Add the composed reader and collection route**

Add `workflowDiagrams.list(query)` to `ApiApplications`. The reader accepts `CollectionQuery` and behaves as follows:

- no `workItemKey`: enumerate only `root.config.orchestration.workflows`, resolve the current compiled definition for each name, and build definition-only diagrams;
- `workItemKey`: decode the key, resolve the work item and its primary workflow, resolve that instance’s fingerprinted definition, gather all workflow children and runs using the existing scoped projection helpers, and return one overlaid diagram;
- unknown work item: return `undefined` so the route presents 404;
- existing work item with no primary workflow: return an empty collection, not a configuration fallback.

Register `/api/v1/workflow-diagrams` in `collectionRoutes` with `cursor`, `limit`, and `workItemKey` allowed. Declare the route in `workflow-diagram.ts`, dispatch it in `collectionResult`, compose it in `createSurfaceApiApplications`, and describe query validation and the two collection modes in `api-application.spec.md`.

- [ ] **Step 5: Run focused API tests and architecture checks**

Run: `npx vitest run test/integration/surfaces/api-routes.test.ts -t "workflow diagrams" && npm run lint:architecture && npm run build`

Expected: PASS.

- [ ] **Step 6: Commit the dedicated API**

```bash
git add src/orchestration src/bootstrap/surface-api-workflow-diagram-applications.ts src/bootstrap/surface-api-applications.ts src/surfaces/api src/surfaces/index.ts
git commit -m "feat: expose workflow diagram collection"
```

### Task 7: Replace mocked JSON with the endpoint in both final UI locations

**Files:**
- Modify: `src/surfaces/web/src/api/client.ts`
- Modify: `src/surfaces/web/src/api/decoders.ts`
- Modify: `src/surfaces/web/src/api/query-keys.ts`
- Modify: `src/surfaces/web/src/features/work/work.tsx`
- Modify: `src/surfaces/web/src/features/configuration/configuration.tsx`
- Modify: `src/surfaces/web/test/work-detail.test.tsx`
- Modify: `src/surfaces/web/test/configuration.test.tsx`
- Modify: `src/surfaces/web/test/client.test.ts`

- [ ] **Step 1: Write failing client and page-query tests**

```ts
it('requests current definitions when no work-item key is supplied', async () => {
  await client.workflowDiagrams.list();
  expect(fetch).toHaveBeenCalledWith('/api/v1/workflow-diagrams', expect.any(Object));
});

it('requests the one-item work overlay with its work-item key', async () => {
  await client.workflowDiagrams.list('wk_a');
  expect(fetch).toHaveBeenCalledWith('/api/v1/workflow-diagrams?workItemKey=wk_a', expect.any(Object));
});
```

Add page expectations that Configuration requests the unfiltered collection and Work Overview requests the keyed collection, then renders the returned graph rather than fixture labels.

- [ ] **Step 2: Run focused web tests to verify they fail**

Run: `npx vitest run src/surfaces/web/test/client.test.ts src/surfaces/web/test/work-detail.test.tsx src/surfaces/web/test/configuration.test.tsx`

Expected: FAIL because `workflowDiagrams` is not exposed by `WakeApiClient`.

- [ ] **Step 3: Implement strict decoding and query integration**

Add `decodeWorkflowDiagram` and nested strict decoders. Add `workflowDiagrams.list(workItemKey?, signal?)` to `WakeApiClient` and matching query keys. Replace fixture imports in `WorkDetail` and `ConfigurationPage` with TanStack queries using their existing refresh policies. Preserve loading/error states locally around the diagram; do not make either page’s existing data query depend on the diagram request.

- [ ] **Step 4: Run focused tests and final web verification**

Run: `npx vitest run src/surfaces/web/test/workflow-diagram.test.tsx src/surfaces/web/test/client.test.ts src/surfaces/web/test/work-detail.test.tsx src/surfaces/web/test/configuration.test.tsx && npm run test:web && npm run build:web`

Expected: PASS.

- [ ] **Step 5: Commit the live data wiring**

```bash
git add src/surfaces/web/src/api src/surfaces/web/src/features/work src/surfaces/web/src/features/configuration src/surfaces/web/test
git commit -m "feat: load workflow diagrams from API"
```

### Task 8: Final verification and documentation handoff

**Files:**
- Modify only if verification identifies a scoped defect.

- [ ] **Step 1: Run focused domain/API/web checks**

Run: `npx vitest run test/unit/orchestration/workflow-diagram.test.ts test/integration/surfaces/api-routes.test.ts -t "workflow diagrams" && npm run test:web`

Expected: PASS.

- [ ] **Step 2: Run the project verification gate**

Run: `npm run verify`

Expected: PASS.

- [ ] **Step 3: Inspect the final working tree**

Run: `git status --short && git log --oneline -8`

Expected: no uncommitted workflow-diagram changes and the task commits listed above.

- [ ] **Step 4: Report verification evidence**

Report the exact focused tests, `npm run test:web`, `npm run build:web`, and `npm run verify` results. State that the visual-first checkpoint was approved before API work began.

## Plan self-review

- Spec coverage: Tasks 2-4 implement the final mocked-JSON visual first; Task 4 requires user visual approval before backend work. Tasks 5-7 cover compiled-definition transformation, deduplicated watch and run aggregation, the single collection endpoint, and both UI consumers. Task 3 covers fixed ELK layout, labelled transitions, mobile vertical layout, and active-stage collapse defaults. Task 8 covers verification.
- Placeholder scan: no unfinished markers or unspecified testing steps remain.
- Type consistency: `WorkflowDiagram`, stage/child/transition identifiers, and the `workflowDiagrams.list(workItemKey?)` client capability retain the same names across visual, API, and integration tasks.
