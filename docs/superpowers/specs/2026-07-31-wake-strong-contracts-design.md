# Wake Strong Contracts Design

**Status:** Approved corrective architecture
**Scope:** `src-next` contract vocabularies, event and stream identity, boundary
decoding, and deterministic enforcement
**Parent architecture:**
[`2026-07-30-wake-target-architecture-design.md`](./2026-07-30-wake-target-architecture-design.md)

## 1. Decision

Wake will represent system-owned concepts with domain-owned TypeScript
contracts rather than repeated string literals. TypeScript `as const`
catalogues, derived union types, discriminated unions, branded identifiers,
runtime schemas, and registries are the standard mechanisms.

Plain strings remain only where the value is genuinely:

1. external data that has not yet crossed its adapter decoder;
2. an open extension point resolved through an owning registry;
3. an opaque identifier represented by a branded string; or
4. human-authored free text.

TypeScript `enum` and `const enum` are not used. `as const` catalogues preserve
the JSON values Wake persists and configure cleanly, compose with mapped event
types and discriminated unions, and can be shared with Zod without introducing
a second runtime representation.

This is not a cosmetic replacement of quotes with constants. The objective is
to make invalid states, mismatched payloads, wrong stream identities, unknown
workflow routes, and provider vocabulary leakage difficult or impossible to
express inside a domain.

## 2. Vocabulary classification

Every machine-interpreted string must fit one of these categories:

| Category | Representation | Examples |
| --- | --- | --- |
| Closed, Wake-owned vocabulary | Domain-owned `as const` catalogue plus derived union type and runtime schema | event types, lifecycle states, Run states, correlation roles, retry safety, workspace modes, PR/check states, machine denial codes |
| Open but constrained extension point | Branded string, validating constructor, owning registry, and constants for built-ins | Activity names, workflow names, stage names, signal names, command names, adapter IDs, Resource kinds and capabilities |
| Opaque identity | Branded string with a non-empty validating constructor | WorkItem ID, Resource ID, Run ID, activation ID, workflow-instance ID |
| External vocabulary | Raw string only inside an integration boundary, immediately decoded or translated | GitHub review state, check conclusion, actor type, slash-command convention |
| Human text | Ordinary string | objective, comment body, failure explanation, display label |

A value being serialized as JSON does not make it an untyped string in domain
code. Runtime values remain strings on disk and over HTTP while TypeScript and
runtime schemas constrain their meaning at the relevant boundary.

Catalogues stay with their owning domain. Wake does not create a global enum
containing every event, state, activity, signal, or provider concept.

## 3. Closed catalogue pattern

Closed values use one public runtime catalogue and derive their type from it.
The identity helper also marks the catalogue for the deterministic vocabulary
checker:

```ts
export const RunStatus = defineClosedVocabulary({
  Requested: 'requested',
  Running: 'running',
  Succeeded: 'succeeded',
  Failed: 'failed',
  Cancelled: 'cancelled',
  Ambiguous: 'ambiguous',
} as const);

export type RunStatus = (typeof RunStatus)[keyof typeof RunStatus];

export const runStatusSchema = z.enum([
  RunStatus.Requested,
  RunStatus.Running,
  RunStatus.Succeeded,
  RunStatus.Failed,
  RunStatus.Cancelled,
  RunStatus.Ambiguous,
]);
```

Catalogue declarations deliberately use this one directly exported, inline
shape. Indirect exports, identifier/spread arguments, computed properties, and
shorthand properties are rejected by the architecture check rather than
requiring Wake to implement TypeScript constant evaluation.

Consumers compare against `RunStatus.Succeeded`, not `'succeeded'`. A
discriminated union may use the catalogue values directly.

Machine-readable reason codes are closed values. Descriptive reasons remain
text and are carried separately:

```ts
export interface RunFailure {
  readonly code: RunFailureCode;
  readonly message: string;
}
```

## 4. Open name and identifier pattern

Names that third-party or future modules may add cannot be a global closed
union. They use a branded string and an owning registry:

```ts
export type ActivityName = Brand<string, 'ActivityName'>;

export function activityName(value: string): ActivityName {
  if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(value))
    throw new Error(`Invalid Activity name: ${value}`);
  return value as ActivityName;
}

export const BuiltInActivityName = {
  Agent: activityName('agent'),
  PullRequestApprove: activityName('pr.approve'),
  PullRequestMerge: activityName('pr.merge'),
} as const;
```

Configuration starts as untrusted strings. Compilation resolves each string
through its registry and returns branded compiled identifiers. Code after
compilation does not repeatedly parse, cast, or compare raw names.

Opaque IDs follow the same branded-constructor pattern but are not registered.
Where practical, a contract accepts the specific ID brand rather than
`string`.

## 5. Typed stream identity

The stream reference persisted in an event envelope is a domain contract. A
domain never constructs one by repeating its kind:

```ts
export interface EntityRef<
  Kind extends string = string,
  Id extends string = string,
> {
  readonly kind: Kind;
  readonly id: Id;
}
```

Each owning domain defines stream kinds and constructors in
`contracts/streams.ts`:

```ts
export const WorkStreamKind = {
  WorkItem: 'work-item',
} as const;

export type WorkItemStreamRef = EntityRef<
  typeof WorkStreamKind.WorkItem,
  WorkItemId
>;

export function workItemStream(id: WorkItemId): WorkItemStreamRef {
  return { kind: WorkStreamKind.WorkItem, id };
}

export function isWorkItemStream(ref: EntityRef): ref is WorkItemStreamRef {
  return ref.kind === WorkStreamKind.WorkItem;
}
```

Application and domain code use `workItemStream(id)`, `resourceStream(id)`,
`runStream(id)`, `workflowInstanceStream(id)`, and named coordination-stream
constructors. The low-level `entityRef()` constructor is not exported through
the kernel public entry point after stream migration. Domain stream contracts
construct the structural reference from already validated branded IDs.

Composite stream IDs are also hidden behind named constructors. Code does not
repeat fragments such as ``primary:${workItemId}``.

`module.json` declares exact owned stream kinds. The manifest checker rejects
duplicate stream ownership. A domain may append an event to a stream owned by
another domain only through that domain's public typed command/service or an
explicit public stream contract required for a cross-domain audit fact.

The persistence adapter may privately serialize `kind` and `id` into a map or
file key. That storage key is not a domain vocabulary and remains an
implementation string inside the adapter.

## 6. Typed event contract

The generic envelope remains in `kernel`; domains own every canonical event
type, payload, stream, and runtime decoder.

```ts
export interface EventDraft<
  Type extends string = string,
  Payload = unknown,
  Stream extends EntityRef = EntityRef,
> {
  readonly eventType: Type;
  readonly stream: Stream;
  readonly payload: Payload;
  // common metadata omitted
}

export interface EventEnvelope<
  Type extends string = string,
  Payload = unknown,
  Stream extends EntityRef = EntityRef,
> extends EventDraft<Type, Payload, Stream> {
  readonly sequence: number;
  readonly globalPosition: number;
  readonly recordedAt: string;
}

export type EventUnion<
  Payloads extends object,
  Stream extends EntityRef,
> = {
  [Type in keyof Payloads & string]: EventEnvelope<Type, Payloads[Type], Stream>;
}[keyof Payloads & string];
```

A domain event file exposes:

- one `as const` event-type catalogue;
- one payload map keyed by catalogue values;
- the mapped draft and envelope unions;
- strict Zod payload/envelope schemas;
- a decoder for persisted generic envelopes;
- an ownership predicate that distinguishes an unrelated event from an
  invalid event in the domain's namespace.

Example:

```ts
export const WorkEventType = {
  ItemCreated: 'work.item-created',
  ObjectiveRevised: 'work.objective-revised',
  ItemLinked: 'work.item-linked',
  ItemClosed: 'work.item-closed',
  ItemCancelled: 'work.item-cancelled',
} as const;

export interface WorkEventPayloads {
  readonly [WorkEventType.ItemCreated]: { readonly objective: string };
  readonly [WorkEventType.ObjectiveRevised]: { readonly objective: string };
  readonly [WorkEventType.ItemLinked]: WorkItemLinkedPayload;
  readonly [WorkEventType.ItemClosed]: WorkItemClosedPayload;
  readonly [WorkEventType.ItemCancelled]: WorkItemCancelledPayload;
}

export type WorkEvent = EventUnion<WorkEventPayloads, WorkItemStreamRef>;
```

Event factories return the exact draft member. Folds and projectors accept
decoded domain event unions and switch exhaustively on catalogue values.
Payloads are never recovered with `String(payload.value)`,
`Number(payload.value)`, or unchecked assertions.

Raw event names may appear only in the owning event catalogue, serialized test
fixtures explicitly exercising corrupt/external input, and user-authored
workflow configuration before compilation. Internal comparisons, watch
matching, trace formatting tests, and event construction use exported
catalogue members.

## 7. Persistence and decoding boundary

The event journal is intentionally generic. It validates the common envelope,
append invariants, ordering, idempotency, and physical encoding without
depending on any domain.

On JSONL read, the filesystem adapter parses unknown JSON through a strict
common-envelope schema. It does not cast `JSON.parse()` directly to
`EventEnvelope`.

Before a generic persisted envelope enters a domain fold, projector, policy,
or reactor, the owning repository or event selector invokes the domain
decoder:

```text
JSONL unknown
  -> common envelope decoder
  -> generic EventEnvelope
  -> domain ownership check
  -> strict domain payload + stream decoder
  -> typed domain event
  -> fold/project/react
```

An event outside a projector's owned namespace is ignored by that projector.
An event inside the namespace with an unknown type, wrong stream kind, or
invalid payload is corruption and fails with event ID/global position context.
It is never silently coerced.

Adapter evidence follows the same rule but its decoder and raw payload remain
owned by the adapter. Core domains consume only translated canonical commands,
signals, and events.

No snapshots or upcasting framework are introduced by this refactor.

## 8. Activities and orchestration

`ActivityDefinition` is generic in both input and outcome:

```ts
export interface ActivityDefinition<
  Name extends ActivityName,
  Input,
  Outcome extends ActivityOutcome,
> {
  readonly name: Name;
  readonly inputSchema: z.ZodType<Input>;
  readonly outcomeSchema: z.ZodType<Outcome>;
  readonly outcomeKinds: readonly Outcome['kind'][];
  readonly handler: ActivityHandler<Input, Outcome>;
}
```

Each Activity owns a closed outcome union even though the registry is open to
new Activities. The registry validates input and outcome without returning
`unknown` or the unconstrained `ActivityOutcome<string, unknown>` to the
caller.

Workflow configuration remains concise and string-based at its YAML/JSON
boundary. The compiler:

1. validates syntax with strict Zod schemas;
2. resolves workflow, stage, Activity, signal, and command names;
3. validates every outcome-route key against the referenced Activity's
   declared outcomes;
4. rejects missing/unknown stages and reserved terminal words;
5. returns branded compiled identifiers and structural transition targets.

Compiled routes do not represent terminals as stage-like strings:

```ts
export const TransitionTargetKind = {
  Stage: 'stage',
  Complete: 'complete',
  AwaitSignal: 'await-signal',
} as const;

export type TransitionTarget =
  | { readonly kind: typeof TransitionTargetKind.Stage; readonly stage: StageName }
  | { readonly kind: typeof TransitionTargetKind.Complete }
  | { readonly kind: typeof TransitionTargetKind.AwaitSignal };
```

Retry safety, execution kind, workspace mode, cardinality, correlation role,
PR state, check state, delivery state, and similar machine decisions use
closed catalogues. The current upper/lower-case retry-safety aliases are
removed; one canonical value is accepted.

## 9. Resources and integration translation

Resource kinds and capabilities are open extension points. They use branded
validated strings, an owning catalogue/registry, and constants for Wake's
built-ins. They are not a closed global union and are not anonymous strings.

Provider vocabulary is decoded once inside its integration:

```text
GitHub comment "/accepted"
  -> GitHub comment-command decoder
  -> canonical review decision signal

GitHub review state "APPROVED"
  -> GitHub payload decoder
  -> canonical PR review state
```

The slash-command convention therefore belongs to
`integrations/github/application`, not `activities/review`. Activities own the
canonical review decision and authorization policy; GitHub owns how a comment
expresses it.

Unknown provider values produce an explicit ignored/unsupported result or a
boundary validation error according to the provider contract. They do not
flow into core state.

## 10. Deterministic enforcement

Deterministic enforcement composes existing tools rather than implementing a
second TypeScript semantic analyser:

1. TypeScript types and compile-only contract tests enforce exact event
   type/payload/stream relationships and preserve branded stream IDs through
   event factories.
2. ESLint `no-restricted-imports` prevents domain/application code importing
   generic `EventDraft`, `EventEnvelope`, or the low-level stream constructor.
3. ESLint `no-restricted-syntax` prohibits `String()` and `Number()` coercion
   in domain/application code. A local function shadowing either built-in is
   also prohibited; those names are misleading in a domain.
4. A small TypeScript-AST vocabulary checker recognizes only directly
   exported, inline catalogues, rejects unsupported catalogue shapes, and
   rejects registered event, stream, and closed-vocabulary literals outside
   their exact declaration initializer.
5. Module-manifest tests verify event namespace and exact stream-kind
   ownership.

The vocabulary checker does not resolve TypeScript symbols, infer event
provenance, or reproduce ESLint scope analysis. It reports file, line,
offending value, and the contract symbol that must replace it. Tests prove each
supported declaration, prohibited duplication, invalid declaration shape, and
permitted boundary case.

Static enforcement complements type design; it does not attempt to ban every
string literal. It deliberately permits:

- provider values inside integration decoders;
- filesystem error codes and private persistence keys inside adapters;
- human text;
- serialized corrupt-input fixtures;
- validated configuration at the parsing boundary.

All permitted exceptions are exact file-pattern boundaries. Provider raw
values are allowed only in integration files explicitly named `*-decoder.ts`,
`*-translator.ts`, or `*-translation.ts`; persistence keys only inside
`persistence`; corrupt fixtures only in `*.corrupt-fixture.ts`. There is no
function-name heuristic, general allowlist, or baseline of current violations.

## 11. Refactor boundaries

The corrective refactor is complete only when:

1. every canonical event has a domain catalogue, payload map, typed stream,
   strict runtime decoder, and typed factory;
2. domain folds/projectors no longer accept erased event payloads;
3. every logical stream is created by its owning typed constructor;
4. closed Wake vocabularies use catalogues;
5. open names and identities use brands and validation/registries;
6. provider strings stop at integration decoders;
7. workflow compilation produces structural, typed routes;
8. Activity outcomes remain typed through registry, execution, and
   orchestration;
9. the architecture checker passes without a baseline or suppressions;
10. existing E2E behavior remains green, including failure and recovery
    scenarios.

The old literal values remain the serialized values where they are correct.
This is an internal contract correction, not an event migration or
compatibility project.
