# Wake Event Contract Corrections Implementation Plan

> **For coding agents:** Execute each task test-first. Do not begin Task 23 until
> both corrective tasks below are complete and verified.

**Goal:** Close the event-contract gaps discovered after Tasks 21 and 22 without
carrying legacy implementation structure into the target architecture.

**Architecture:** Every owned event family has a closed event vocabulary, an
exact payload map, event/draft unions tied to its owned stream, strict runtime
decoders/selectors, and typed draft construction. The journal remains the
authority; projectors and reactors consume decoded events and composition makes
them reachable in production.

**Tech stack:** TypeScript, Zod, Vitest, the shared event journal and projection
runner.

---

## Task 22A: Type activation claim events

**Files:**

- Modify: `src-next/execution/contracts/{events,event-factory}.ts`
- Modify: `src-next/execution/application/{activation-claim,run-repository,execution-projection,recovery-service}.ts`
- Modify: `src-next/execution/domain/run.ts`
- Modify: `test-next/execution/event-contracts.test.ts`
- Create: `test-next/execution/activation-claim.test.ts`

1. Add failing tests for both activation events, malformed payloads, crossed
   Run/Activation streams, selection, active-claim rejection, release, and
   reclaim after release.
2. Add `ActivationClaimed` and `ActivationReleased` to
   `ExecutionEventType`. Define separate Run and Activation payload maps and
   unions so each event can only use its owned stream at compile time.
3. Extend the strict Zod contract. Add stream-specific decoders/selectors and
   use the Run selector in the Run projection.
4. Extend `createExecutionEventDraft` with exact Run/Activation inputs. Replace
   generic draft construction, raw event strings, `unknown` payload reflection,
   and unchecked reads in `activation-claim.ts`.
5. Use Run-only event/draft types in the Run aggregate, repository, and
   recovery paths.
6. Run focused tests, contract/architecture gates, `knip:next`,
   `verify:next`, and legacy verification.

## Task 21B: Correct durable delivery before Task 23

Run this task in a fresh session from the refactor branch after Task 22A.

**Files:**

- Modify: `src-next/integrations/delivery/contracts/events.ts`
- Modify: `src-next/integrations/delivery/application/{delivery-projector,delivery-service,delivery-outcome-reactor}.ts`
- Modify: `src-next/integrations/{index.ts,module.json,MODULE.md}`
- Modify: the target bootstrap/composition root and projection registry
- Replace or extend: `test-next/integrations/delivery-*.test.ts`
- Replace or extend: `test-next/e2e/scenarios/{outbox-crash,pr-merge-delivery}.test.ts`
- Extend: contract/architecture checker tests where nested event families or
  typed streams are not currently enforced

Acceptance criteria:

1. Delivery owns a closed `DeliveryEventType`, exact payload map, typed
   event/draft unions, exact delivery stream, strict Zod decoder/selector, and
   typed factory. Owned malformed events throw; unrelated namespaces return
   `null`.
2. No delivery production path uses event-type magic strings,
   `Record<string, unknown>`, `as never`, primitive coercion to recover domain
   data, or synthetic envelopes reconstructed from projection fields.
3. Delivery events carry the correlation needed by the outcome reactor in
   their declared payloads. Exhaustive typed folds preserve the canonical
   intent event ID and global position rather than copying intent authority.
4. The delivery projection is registered with the production projection
   runner; the service and outcome reactor are exported and composed from the
   target bootstrap/host path.
5. E2E tests use the composed production services, central journal,
   projections/checkpoints, and durable provider fakes. They prove restart and
   reconciliation, exactly-once provider effect, and workflow progression only
   after confirmed delivery. Callback-only service tests remain unit tests and
   are not labelled E2E.
6. `module.json` and the architecture checker cover the complete nested
   delivery event namespace and stream ownership. Add a failing checker
   fixture before changing the checker.
7. Verify with `lint:contracts`, `lint:architecture`, `knip:next`,
   `verify:next`, and `verify`; commit the repair independently before Task 23.

