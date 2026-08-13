# Operator Retry for Blocked Failed Work Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let operators safely retry an open WorkItem's failed, blocked workflow stage while preserving all history.

**Architecture:** Add a durable orchestration recovery fact followed atomically by a new stage activation. Fold the block reason and accepted command identities to make recovery eligibility explicit and retries idempotent. Compose the existing API route and expose a derived eligibility flag to the work-detail UI.

**Tech Stack:** TypeScript, Vitest, Zod, event sourcing, React Query, React Testing Library.

---

## File structure

- `src/orchestration/contracts/events.ts`, `event-decoder.ts`, `contracts/views.ts`, and `domain/workflow-instance-events.ts`: recovery contract and fold.
- `src/orchestration/domain/operator-retry-policy.ts`: pure eligibility and next-activation decision.
- `src/orchestration/application/advance-workflow.ts` and `orchestration-service.ts`: durable command seam.
- `src/bootstrap/surface-api-work-applications.ts`: route composition and conflict translation.
- API orchestration contract/presenter/web decoder and `work.tsx`: eligibility transport and conditional button.
- Orchestration, scenario, API, and web tests plus workflow/UI docs: proof and public behavior.

### Task 1: Add recovery event and aggregate state

**Files:** `src/orchestration/contracts/events.ts`, `src/orchestration/contracts/event-decoder.ts`, `src/orchestration/contracts/views.ts`, `src/orchestration/domain/workflow-instance-events.ts`, `src/orchestration/domain/workflow-instance.spec.md`, `test/unit/orchestration/event-contracts.test.ts`.

- [ ] Write a failing event-contract test for `OperatorRetryRequested` with `{ activationId, commandId: 'command-operator-retry' }`; assert it folds into `operatorRetryCommandIds`, `InstanceBlocked` folds `blockReason`, and an empty command id rejects.
- [ ] Run `npx vitest run test/unit/orchestration/event-contracts.test.ts`; expect failure because the event and view fields are absent.
- [ ] Add the event/payload and strict decoder; initialise/fold command ids; retain the latest block reason; document the fields in the component spec.

```ts
case OrchestrationEventType.OperatorRetryRequested:
  state.operatorRetryCommandIds.push(event.payload.commandId);
  return;
case OrchestrationEventType.InstanceBlocked:
  state.status = WorkflowStatus.Blocked;
  state.blockReason = event.payload.reason;
  return;
```

- [ ] Re-run the test and commit the event-contract files and test with `feat: record operator retry recovery facts`.

### Task 2: Add the pure recovery decision

**Files:** Create `src/orchestration/domain/operator-retry-policy.ts`; modify `src/orchestration/domain/interpreter.ts`; test `test/unit/orchestration/operator-retry-policy.test.ts`.

- [ ] Write failing tests for a one-stage workflow blocked by an unconfigured failed result: decision drafts must be recovery then `ActivityRequested`, with ordinal 2 and current stage configuration. Table-test active, completed, waiting, differently blocked, supplemental, follow-on, and non-failed rejection.
- [ ] Run `npx vitest run test/unit/orchestration/operator-retry-policy.test.ts`; expect failure because the policy is absent.
- [ ] Export `requestOperatorRetry(definition, state, input)` and `isOperatorRetryEligible(view)`. Accept only `blocked`, `blockReason === 'unconfigured outcome failed'`, accepted completed ordinary activation, and `lastOutcome.kind === 'failed'`; otherwise return a stable ignored reason. Append the recovery fact plus the next ordinal stage activation.

```ts
if (!isOperatorRetryEligible(state))
  return { kind: 'ignored', reason: 'workflow is not blocked for an unconfigured failed outcome' };
```

- [ ] Run `npx vitest run test/unit/orchestration/operator-retry-policy.test.ts test/unit/orchestration/interpreter.test.ts`; expect PASS; commit as `feat: decide safe operator workflow retries`.

### Task 3: Add durable application-service idempotency

**Files:** Modify `src/orchestration/application/advance-workflow.ts` and `src/orchestration/application/orchestration-service.ts`; test `test/unit/orchestration/operator-retry-service.test.ts` and `test/e2e/scenarios/operator-retry-blocked-work.test.ts`.

- [ ] Write failing service/scenario tests using a `TestWorld` activity returning failed then done without a failed route. After blocking, issue the same `retryBlockedFailedStage` command twice; assert one recovery fact, ordinal 2, two immutable activation ids/Runs after advance, and a completed workflow. Assert an active instance rejects.
- [ ] Run `npx vitest run test/unit/orchestration/operator-retry-service.test.ts test/e2e/scenarios/operator-retry-blocked-work.test.ts`; expect failure because the command is absent.
- [ ] Implement `retryBlockedFailedStage`: return the current view if its command id was folded; otherwise invoke the pure policy, throw its stable reason if ignored, append its two drafts at the loaded sequence, and reload. Forward it from `OrchestrationService`; never alter prior events or Runs.

```ts
if (loaded.view.operatorRetryCommandIds.includes(context.commandId)) return loaded.view;
const decision = requestOperatorRetry(this.workflows.definition(loaded.view.workflowName), loaded.view, input);
if (decision.kind === 'ignored') throw new Error(decision.reason);
await this.repository.append(id, loaded.sequence, decision.events);
```

- [ ] Re-run those tests; expect PASS; commit as `feat: retry blocked failed workflow stages`.

### Task 4: Wire API and transport eligibility

**Files:** Modify `src/bootstrap/surface-api-work-applications.ts`, `src/bootstrap/surface-api-work-applications.spec.md`, `src/surfaces/api/contracts/orchestration.ts`, `src/surfaces/api/presenters/orchestration.ts`, `src/surfaces/web/src/api/decoders.ts`; test `test/integration/surfaces/api-routes.test.ts` and `test/e2e/scenarios/api-domain-shape.test.ts`.

- [ ] Write failing tests: eligible primary retry returns 202 and `work:<idempotencyKey>`; ineligible retry returns 409 `{ code: 'retry-ineligible', detail }`; work detail presents `primary.retryEligible: true` only for the recovery state.
- [ ] Run `npx vitest run test/integration/surfaces/api-routes.test.ts test/e2e/scenarios/api-domain-shape.test.ts`; expect failure.
- [ ] Compose `retry`: decode/load WorkItem; conflict for missing/non-open/deleted work; resolve the primary id; invoke recovery with the API command context; translate rejection to `{ conflict: true, code: 'retry-ineligible', detail }`. Add optional `retryEligible` to the response, presenter, and web decoder.

```ts
return { conflict: true, code: 'retry-ineligible', detail: (error as Error).message };
```

- [ ] Re-run the API tests; expect PASS; commit as `feat: expose operator retry command`.

### Task 5: Add Retry control and documentation

**Files:** Modify `src/surfaces/web/src/features/work/work.tsx`, `docs/workflows.md`, `docs/specs/control-plane-ui.md`; test `src/surfaces/web/test/work-detail.test.tsx`.

- [ ] Write failing UI tests: hide Retry for null/ineligible primary; for eligible blocked primary, click Retry and assert POST `/commands/retry`, refreshed work detail, and visible problem feedback.
- [ ] Run `npm --workspace @atolis-hq/wake-web run test -- work-detail.test.tsx`; expect failure because no control exists.
- [ ] Add `retry` to the mutation union and render the button only for `primary?.retryEligible === true`; reuse pending/error feedback and cache invalidation. Document fixed-parameter failed-stage recovery; retain the prohibition on arbitrary Run retries with changed parameters.

```tsx
{primary?.retryEligible === true && <Button disabled={command.isPending} onClick={() => command.mutate('retry')}>Retry</Button>}
```

- [ ] Re-run the web test; expect PASS; commit as `feat: add work detail retry control`.

### Task 6: Verify the full change

- [ ] Run focused suites: `npx vitest run test/unit/orchestration/event-contracts.test.ts test/unit/orchestration/operator-retry-policy.test.ts test/unit/orchestration/operator-retry-service.test.ts test/integration/surfaces/api-routes.test.ts test/e2e/scenarios/operator-retry-blocked-work.test.ts` and `npm --workspace @atolis-hq/wake-web run test -- work-detail.test.tsx`; expect PASS.
- [ ] Run broader suites: `npm run test:unit`, `npm run test:integration`, `npm run test:e2e`, `npm run test:web`, `npm run build`, and `npm run check:specs`; expect PASS.
- [ ] Run `git diff --check` and `git status --short`; expect no whitespace errors and only feature changes plus existing unrelated user work.
