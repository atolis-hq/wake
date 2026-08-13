# Stage approval-by-default — design

## Goal

`E2E-LIFECYCLE-001`'s plain lifecycle scenario (no watchers) was originally
specified as a fully unattended happy path: refine then implement, no human
input required. That was a mistake in the original scenario design — a
stage with no watcher and no explicit `await` should pause for human
approval before advancing, by default. This is the design for that default,
and for the opt-out a workflow author uses when they genuinely want a stage
to proceed unattended.

## The default is global, not opt-in

Every stage's `done` route requires human approval before advancing, unless
that stage explicitly opts out or already has its own gate. This is a
property of the compiler's default, not something a workflow has to ask
for — a new workflow author gets safe-by-default behavior without knowing
this mechanism exists. `failed`/`rejected`/`blocked` routes are untouched;
only `done` (the "ready to advance" outcome) is affected, matching the
existing hand-written `approval` workflow's own pattern exactly.

## A `watchGates`-gated route is automatically exempt

`dark-factory`'s `refine`/`implement` routes already gate on a watch's own
verdict — which is itself a human-in-the-loop-or-watch approval, not an
absence of one. A route with `watchGates` (or a hand-written `await`)
already declared never gets the implicit default layered on top, and needs
no separate opt-out flag to say so. The compiler already rejects a route
that declares both `await` and `watchGates` together
(`compiler.ts:132-135`); this default follows the same precedence — an
explicit gate of either kind always wins.

## Mechanism: a compile-time default, not a new runtime concept

A stage gains an optional `requiresApproval: boolean` field on
`stageConfigSchema` (`src-next/orchestration/contracts/config.ts`),
defaulting to `true` when absent. In `compileStage`
(`src-next/orchestration/domain/compiler.ts:116-180`), when compiling the
`done` outcome route specifically: if that route has no `await` and no
`watchGates`, and the stage's `requiresApproval !== false`, the compiler
treats the route as if the workflow author had written
`await: { signal: 'approved', from: [human] }` themselves, and compiles it
through the exact same `compileAwait` path already used for hand-written
`await` configs.

This is deliberately not a new signal kind, event type, or runtime
concept. At runtime, an implicitly-injected wait is indistinguishable from
a hand-authored one: `signal-policy.ts`'s `acceptSignal`, and the
`/approved`/`/changes` human-override mechanism already generalized this
session (`inbound-review-signals.ts`), work completely unchanged, because
nothing new is happening at the signal layer — only the compiler's default
for *what to compile* changed. `CompiledStage`/`CompiledOutcomeRoute` don't
gain any new fields; `requiresApproval` is fully consumed at compile time.

Sketch of the injection point inside `compileStage`'s route-compilation
loop:

```ts
const effectiveAwait =
  route.await ??
  (outcomeKind === ActivityOutcomeKind.Done &&
  route.watchGates === undefined &&
  stage.requiresApproval !== false
    ? { signal: 'approved', from: [ApprovalAuthorityKind.Human] }
    : undefined);
```
— then compile `effectiveAwait` in place of `route.await` wherever the
existing code already does so.

## Scope and migration

This is a global default, so every existing workflow whose `done` routes
have no gate today starts pausing for approval:

- `~/wake-next/config.workflows.yaml`'s `default` and `fake-scenario-test`
  workflows keep their names but now behave like `approval` did — pausing
  at each stage. `dark-factory`/`plan-review`/`pr-review` are unaffected
  (already watchGate-gated throughout).
- `test-next/e2e/fixtures/wake-root-lifecycle` (backs
  `E2E-LIFECYCLE-004`, "mints a work item from a ticket and delivers a
  comment per stage") and `E2E-LIFECYCLE-001` ("happy path") both currently
  assume ungated completion. Both get updated to supply the approval
  signal at each stage (the same way the existing `approval`-workflow test
  already does), so they end up proving the new default actually gates,
  rather than being weakened to opt out of it.
- A new scenario is added proving the opt-out path: a stage with
  `requiresApproval: false` runs its `done` route unattended, end to end,
  with no signal ever supplied.

## Testing

- Unit test on the compiler: a stage with no `await`/`watchGates` and no
  `requiresApproval` compiles a `done` route with an injected `await`
  identical in shape to a hand-written `{signal:'approved', from:[human]}`.
- Unit test: `requiresApproval: false` compiles a `done` route with no
  `await` at all (proceeds immediately, matching today's ungated
  behavior).
- Unit test: a route with `watchGates` already declared compiles
  unchanged regardless of `requiresApproval`'s value (present, absent, or
  explicitly `true`) — the watch gate always wins, no double-gating.
- Existing compiler test coverage for `await`/`watchGates` mutual
  exclusion (`compiler.ts:132-135`) is unaffected — the default only ever
  fills in an *absent* `await`, never conflicts with a hand-written one.
- `E2E-LIFECYCLE-001`/`E2E-LIFECYCLE-004` updated to post the approval
  signal at each stage before asserting completion.
- New `E2E-LIFECYCLE-005`-style scenario: a stage configured with
  `requiresApproval: false` completes its `done` route with no signal
  supplied, proving the opt-out.

## Deferred, not designed here

- Nothing about GitHub delivery, the watchGate verdict channel, or comment
  context injection changes — this design is entirely inside the
  orchestration compiler's own default.
- Whether `requiresApproval` should ever be settable at the workflow level
  as a bulk convenience (rather than per stage) is not addressed — the
  confirmed design is stage-level only, matching "each stage expects
  approval unless specified on the stage."
