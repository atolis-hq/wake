# `src-next/` structural review — 2026-08-01

Structural review of the in-progress target architecture. Scope is **structure, not
behaviour**: technical patterns, file layout, coding style, type usage, event modelling,
generics, constants, readability, and encapsulation. Correctness, performance, and
functional completeness were explicitly out of scope and were not assessed.

Reviewed at commit `a4df713` on `rewrite/wake-target-architecture`, with the Task 25A
working tree in place. Covers all 11 modules under `src-next/`, `test-next/`, and the
supporting lint tooling (`scripts/`, `dependency-cruiser.config.mjs`, `eslint.config.js`).
The browser app under `src-next/surfaces/web/` was surveyed but not reviewed in depth.

---

## 1. Verdict

The architecture is sound and the discipline is real. Measured rather than asserted:

| Signal                                             | Value                          |
| -------------------------------------------------- | ------------------------------ |
| `any` / `as unknown as` in `src-next/`             | 0 / 0                          |
| Non-null assertions / `as never`                   | 3 / 2                          |
| `MODULE.md` files with identical section headings  | 11 of 11                       |
| `domain/` files importing a journal, clock, or store | 0                            |
| Largest file (effective lines)                     | 311                            |
| `knip` findings                                    | 2 (one from the in-flight branch) |

Strict mode, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes` are all on. The
module DAG is declared, acyclic, and machine-enforced; `index.ts` is a genuine boundary.
The custom AST linter (~750 lines across `scripts/lib/`) enforcing closed vocabularies for
event types and stream kinds is unusual and valuable.

Everything below is about **consistency and where the discipline stops**, not about
rescuing a weak design. The findings are ranked by structural leverage.

---

## 2. Open decisions

These change what the remediation looks like, so settle them before actioning §4.

| #   | Decision                                                                                                 | Recommendation                                                            |
| --- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| D1  | Type↔schema binding: schema-first `z.infer`, or types-first with mandatory `z.ZodType<X>`?                | Types-first + mandatory annotation + per-domain exhaustiveness test        |
| D2  | Does the contract-vocabulary lint and dependency-cruiser extend to `test-next/`?                          | Yes — extend both                                                          |
| D3  | Duplicate brand tags across `activities` and `orchestration`: distinct tags, or accept and document?      | Distinct tags with an explicit conversion at the seam                      |
| D4  | Is `activities` feature-slicing (`agent/`, `pr/`, `review/`) intentional?                                 | Keep it, but add `{domain,application}` sub-layers so the eslint rule applies |
| D5  | Do `surfaces/` DTOs follow domain vocabulary rules, or are they explicitly exempt?                        | Explicitly exempt, documented in `surfaces/MODULE.md`                      |
| D6  | Raise the 300-line `max-lines` cap?                                                                       | No — differentiate by directory instead (see §3)                            |

---

## 3. The 300-line limit

**Do not raise it uniformly.** The measurement shows a raise would not solve the problem
it appears to solve.

The cap has produced clusters of satellite files whose names describe *size overflow*
rather than a concept. Their combined effective line counts:

| Cluster                    | Files                                                                                              | Total |
| -------------------------- | -------------------------------------------------------------------------------------------------- | ----- |
| `orchestration/contracts/` | `events.ts` (193), `event-types.ts` (64), `event-decoder.ts` (180), `event-payload-schema.ts` (101), `event-envelope-schema.ts` (34) | **572** |
| `activities/contracts/`    | `events.ts` (235), `event-schema.ts` (175), `event-fact-schemas.ts` (238)                            | **648** |
| `execution/contracts/`     | `events.ts` (285), `event-schema-components.ts` (65), `event-factory.ts` (79)                        | **429** |

Raising the cap to 400 recombines nothing. Raising it to 650 — the number that would
actually collapse these — is indefensible for application code.

The real distinction is **declarative catalogue vs. behavioural code**. A 500-line
discriminated union is linear and skimmable; its length is a function of how many events
the domain has, not of complexity. A 500-line service is not. The current uniform cap
applies the same pressure to both, and the contracts side is where it produced fragmentation
without reducing anything — a reader now needs five files to understand one orchestration event.

### Recommendation

Split the eslint rule by directory:

```js
{
  files: ['src-next/**/contracts/**/*.ts'],
  rules: { 'max-lines': ['error', { max: 500, skipBlankLines: true, skipComments: true }] },
},
{
  files: ['src-next/**/{application,domain,infrastructure}/**/*.ts'],
  rules: { 'max-lines': ['error', { max: 300, skipBlankLines: true, skipComments: true }] },
},
```

Then collapse the clusters: orchestration 5 files → 2 (`events.ts` carrying types and
payloads, `event-decoder.ts` carrying envelope and payload schemas), activities 3 → 2,
execution 3 → 2. Keep `max-lines-per-function` at 80 everywhere — that one is doing
useful work and no evidence suggests otherwise.

Two supporting notes:

- The 300 cap on behavioural code is working. Only `execution/application/execution-service.ts`
  (311 effective) sits at the ceiling, and it is a legitimate candidate for decomposition
  on its own merits.
- Any file that still needs splitting after the change should be named for its **concept**,
  never for its role as a fragment. `event-schema-components.ts` and
  `event-payload-schema.ts` are names that only make sense if you know the file they were
  cut out of.

---

## 4. Findings

### F1 — Two hand-maintained sources of truth for every event payload (high)

Every event-owning domain writes a payload interface map *and* a parallel Zod discriminated
union, kept in sync manually. The strength of the binding is inconsistent:

- `execution/contracts/events.ts:265` — `const runEventSchema: z.ZodType<RunExecutionEvent>`.
  A real bidirectional constraint.
- `work/contracts/events.ts:84`, `orchestration/contracts/event-decoder.ts:158` — binding
  comes only from `return result.data` assignability. That is one-directional: a schema
  that omits a variant, or narrows a payload, still compiles clean.
- `bootstrap/config/root-schema.ts` uses **both idioms in one file** — hand-written types
  for seven namespaces, `z.infer` for `orchestration` — then ends on
  `rootConfigSchema.parse(input) as ResolvedWakeModulesConfig`, casting away the mismatch
  it exists to catch.

Related looseness at the decode boundary: `orchestration/contracts/event-payload-schema.ts:47`
decodes activity outcomes as `{ kind: z.string().min(1) }`, so a persisted outcome kind is
never validated against any vocabulary.

**Action (pending D1).** Standardise on one idiom. If types-first: make the
`z.ZodType<XEvent>` annotation mandatory on every domain schema, add a per-domain test
asserting every key of `XEventType` has a corresponding schema variant, and remove the cast
in `parseRootConfig`.

### F2 — `ReturnType<typeof …>` in place of the named type that already exists (high)

33 occurrences. Two distinct problems:

*Noise*, where a named branded type is exported from a sibling file:

- `execution/contracts/events.ts:96,101` — `ReturnType<typeof runId>` instead of `RunId`
- `execution/application/run-liveness-service.ts` — 5 occurrences of the same
- `bootstrap/surface-api-work-applications.ts:92,116,132` — `ReturnType<typeof workItemId>`
- `orchestration/domain/compiler.ts:81`, `execution/application/recovery-service.ts:196`

*Structural*, where the application's composition contract becomes inferred rather than declared:

- `bootstrap/composition-root.ts:38-43` — all six service members typed as
  `ReturnType<typeof create…Service>`.

`OrchestrationService` compounds this: ~30 delegating methods, none with a declared return
type, so the public API of the largest domain is defined entirely by implementation
inference. `WorkService`, `ResourceService`, `PullRequestService`, `DeliveryService`, and
`ScheduleService` have proper named interfaces; orchestration, execution, and control-plane
do not.

**Action.** Mechanical substitution for the noise cases. Declare named service interfaces
for orchestration, execution, and control-plane, and have `CompositionRoot` reference those.

### F3 — Closed-vocabulary enforcement stops at three boundaries (high)

`scripts/check-contract-vocabulary.mjs:11` scans `src-next` only; dependency-cruiser is
configured for `src-next` only. Consequences:

**Tests are unenforced.** 256 raw event-type string literals across `test-next/`.
`test-next/e2e/scenarios/golden-path.test.ts:44-56` asserts an event sequence in which 11
entries are raw strings and 2 use `ExecutionEventType.*` — in the same array literal.
`CLAUDE.md` says the rule applies to "production code or tests".

The harm is already realised: `'work.created'` appears 3× across
`src-next/surfaces/web/e2e/surface-fixture.ts:173`,
`test-next/surfaces/api-routes.test.ts:140`, and
`test-next/surfaces/cli-runtime-commands.test.ts:33,86`. **It is not a real event type**
(`work.item-created` is). Those assertions are permanently green and assert nothing.

**Tests bypass module public entries.** 36 of 122 test files import from
`src-next/<module>/{contracts,application,domain,infrastructure}/…` rather than `index.js`.
Heaviest: orchestration (29 imports), work (47 across `contracts` + `domain`), activities (20).
The `no-<module>-internals` depcruise rule cannot see them.

**Concepts the linter does not cover in production code.** Actor and source ids
(`'orchestration'` in `orchestration/domain/decision-events.ts:23-24`, `'activities-pr'`),
projection namespaces, checkpoint consumer keys (`` `projection:${name}` ``,
`'reactor:integration.github.inbound'` in `integrations/github/application/inbound-translator.ts:48`),
HTTP methods, and API command names.

The API command names are written three times — the `WorkCommandName` type alias, the regex
in `surfaces/api/routes/commands.ts:41`, and the `workRoutes` array in
`surfaces/api/routes/work.ts` — requiring `match[2]! as WorkCommandName` to reconnect them.

**Action (pending D2, D5).** Extend `checkContractVocabulary` and dependency-cruiser to
`test-next`. Expect a large but mechanical first pass. Separately, decide whether actor
ids, projection namespaces, and checkpoint keys become registered vocabularies — they are
closed sets modelled as free strings today.

### F4 — Composite key formats are ad-hoc string templates (medium)

There is an unnamed, unenforced "structured key" convention spread across modules with no
shared formatter or parser:

- `` `${id}:activity:${ordinal}` `` — `orchestration/domain/decision-events.ts:40`
- `` `${input.activationId}:pr.merge` `` — `activities/pr/merge-authority-gate.ts:24`
  (the `pr.merge` literal duplicates `BuiltInActivityName.PullRequestMerge`)
- `` `primary:${workItemId}` `` — parsed back in `orchestration/contracts/streams.ts:30`
- `` `projection:${definition.name}` `` — `persistence/application/projection-runner.ts`
- `'reactor:integration.github.inbound'` — `integrations/github/application/inbound-translator.ts:48`

Only the `primary:` form has a parser. The rest are write-only conventions that a reader
must reverse-engineer.

**Action.** Introduce a shared key formatter/parser per key family, colocated with the
identifier it composes, and route all construction through it.

### F5 — Seams that quietly un-brand (medium)

`control-plane/application/advance-once.ts:17-51` declares local `OrchestrationPort` and
`ExecutionPort` using bare `string` for `workflowInstanceId`, `activationId`, and
`workItemId` — while importing the branded `WorkflowInstanceView` from that same module in
the same file. It compiles because method-shorthand parameters are bivariant in TypeScript,
so the port is strictly weaker than the service it stands for. `recoverActive?` is also
declared optional though the real service always implements it.

`activities/contracts/activity.ts:19-20` declares `Brand<string, 'WorkflowInstanceId'>` and
`Brand<string, 'OrchestrationGroupId'>` — the **same brand tags** `orchestration` uses.
They are therefore structurally identical and silently interchangeable. The duplication
exists to avoid an `activities → orchestration` dependency, which is the right instinct,
but the current shape gives the appearance of type safety without providing it.

**Action (pending D3).** Brand the local ports' identifiers. Give the activities-side
brands distinct tags (e.g. `'ActivityWorkflowInstanceId'`) and convert explicitly at the
seam. Make `recoverActive` required.

### F6 — Existing rule violations (medium)

Direct contradictions of the rules in `CLAUDE.md`:

- `activities/pr/merge-authority-gate.ts:25` — `correlationId: input.orchestrationGroupId as never`,
  casting a group id into a `CorrelationId` while `correlationId()` is exported from kernel.
- `orchestration/contracts/activity-outcome.ts:31-32` — `Reflect.get` recovering domain
  data. Note that `waitingOutcomeSchema` (`event-payload-schema.ts:52`) already validates
  this shape in Zod *and then calls this function*, which re-validates by hand. Folding the
  validation into the schema removes both the duplication and the `Reflect.get`.
- `activities/contracts/registry.ts:107` — `Reflect.get(value, 'kind')`. The same file's
  `parse()` helper takes a hand-rolled structural duck-type of a Zod schema
  (`{ safeParse(value: unknown): { success: boolean; … } }`) when `z.ZodType` is already
  imported by its sibling.

`execution/domain/run-result.ts:28-30` also uses `Reflect.get`, but on a caught `unknown`
error — that is legitimate boundary normalisation. Either carve it out of the rule
explicitly or relocate the helper out of `domain/`.

### F7 — Identity minting: three derivation sites remain (medium, in flight)

Task 25A is tightening `workItemId` / `resourceId` to `<prefix>-<ulid>`. Three sites still
derive identity from external data and will throw under the new pattern:

- `integrations/github/application/inbound-translator.ts:214` — `resource-github-<key>`
- `integrations/github/application/inbound-translator.ts:218` — `work-github-<key>`
  (contains `i`, which is not valid Crockford base32)
- `control-plane/application/schedule-service.ts:42` — `` work-${safe(config.id)}-${safe(slot.at)} ``

All three violate ADR-0001. The GitHub sites appear to be covered by the in-flight
`integrations/github/contracts/external-key.ts`; **the scheduler site should be confirmed
as in scope.**

Separately, the new `test-next/support/identities.ts` holds its `used` Map at module scope,
shared across the whole test process, which makes seed-collision errors dependent on file
execution order. Scoping it per-`TestWorld` would remove that coupling.

### F8 — Longhand vocabulary unions where the named type exists (low)

`work/contracts/views.ts:5` declares:

```ts
export type WorkState = typeof WorkStatus.Open | typeof WorkStatus.Closed | typeof WorkStatus.Cancelled;
```

which is exactly equivalent to the already-exported `WorkStatus` type
(`ValueOf<typeof WorkStatus>`). The module now exports two names for one concept.

Same pattern in `integrations/github/contracts/events.ts:26-71`: all 3 members of
`PullRequestState`, all 4 of `PullRequestCheckState`, and all 6 of `ProviderPermission`
spelled out longhand. Also `execution/contracts/views.ts:36` and
`execution/contracts/events.ts:60`.

Beyond verbosity this is drift-prone: adding a vocabulary member silently fails to widen
the longhand union, with no error anywhere.

**Action.** Use the `ValueOf` alias for whole vocabularies; `Extract<>` for genuine subsets.

### F9 — Module layout diverges, and the layer lint is path-based (low, pending D4)

Five modules use `contracts/application/domain/infrastructure`. `activities` is
feature-sliced (`agent/`, `pr/`, `review/`); `integrations` is provider-sliced
(`delivery/`, `github/`, `fake/`); `persistence` is store-sliced. The provider and store
slicing are correct and should stay.

The `activities` slicing has an unnoticed cost: the eslint layer rule in
`eslint.config.js` targets
`src-next/{work,resources,activities,orchestration,execution}/{domain,application}/**`, so
it **does not apply to `activities/pr/**` at all**. That is precisely where policy sits
beside journal-touching code — `activities/pr/policy.ts` next to `activities/pr/approve.ts`,
`application.ts`, and `decision-claim.ts`, all of which take an `EventJournal`.

The same rule also does not cover `control-plane` or `integrations`.

**Action (pending D4).** Add `{domain,application}` sub-layers inside the `activities`
feature folders, and extend the eslint glob to `control-plane` and `integrations`.

### F10 — Quick wins, no decision required (low)

| Item                                                                                                    | Location                                            |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `rebuild()` hardcodes `100` as its termination condition while `runOnce`'s page-size default is a separate `100` — changing one silently breaks the loop | `persistence/application/projection-runner.ts`      |
| Module graph declared twice (11 × `module.json` and `dependencyMap`); identical today, generate one from the other | `dependency-cruiser.config.mjs`                     |
| `defineClosedVocabulary` is an identity function with no type effect beyond the `as const` already present at every call site — it is a linter marker and should say so | `kernel/contracts/vocabulary.ts:3`                  |
| `isRecord` copy-pasted in 5 files                                                                        | activities ×2, bootstrap, api/responses, web decoder-primitives |
| `if (loaded.view !== null) return change(…)` followed by an identical `return change(…)` — dead branch    | `work/application/work-service.ts:44-47`            |
| 15 hand-rolled lines scanning UTF-16 surrogates; `String.prototype.isWellFormed()` has existed since Node 20 and `engines` requires ≥24 | `activities/contracts/identifiers.ts:19-31`         |
| `z.enum(Object.values(X) as [T, ...T[]])` cast, alongside a hand-listed `z.enum([X.A, X.B])` idiom elsewhere — a `zodEnumOf(vocabulary)` kernel helper removes both | `execution/contracts/events.ts:198`                 |
| `selectRunExecutionEvent` calls `decodeExecutionEvent` purely for its throwing side effect, then returns `null` — uncommented | `execution/contracts/events.ts:280-295`             |
| The identifier-name regex `/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/` is duplicated 5× | `orchestration/contracts/identifiers.ts` ×4, `activities/contracts/identifiers.ts` |
| `InstanceStarted` payload is a union whose two arms repeat four identical fields verbatim; extract a named base | `orchestration/contracts/events.ts:76-89`           |
| `Readonly<Record<never, never>>` repeated for empty payloads; name it `EmptyPayload` in kernel            | `orchestration/contracts/events.ts`                 |
| Optional-property style split 190 bare `?:` vs 28 `?: … \| undefined` under `exactOptionalPropertyTypes`, where the two genuinely differ | `src-next/` wide                                    |
| eslint uses `tseslint.configs.recommended`, not `recommendedTypeChecked` — `no-floating-promises` is the highest-value missing rule in an almost entirely async codebase | `eslint.config.js`                                  |

---

## 5. Suggested sequencing

1. **Settle D1–D6.** Everything else keys off them.
2. **Mechanical, zero-risk, no decision needed:** F2 noise substitutions, F8, F10.
3. **Tooling changes that generate large mechanical diffs:** the `max-lines` split (§3),
   F3 lint extension. Do these before the cleanups they will flag, not after.
4. **Design changes:** F1 schema binding, F5 branding, F9 layout.
5. **Confirm F7 scheduler coverage** inside the current Task 25A branch rather than deferring.

None of this is load-bearing for correctness. It is all consistency work on an architecture
that is already sound, and it will get cheaper the earlier it lands relative to the
remaining rewrite tasks.
