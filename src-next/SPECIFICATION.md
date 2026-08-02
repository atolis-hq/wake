# Target Behavioural Specification Standard

This standard governs every `SPEC.md` and `*.spec.md` file under `src-next/`.
Specifications are normative behavioural documents: they state what the target
system MUST, MUST NOT, SHOULD, or MAY do. They are not evidence records — they
do not name test files, scenario IDs, implementation class names, or walk
through source code, and they do not link to proofs. Proof that behaviour
matches a specification lives in `docs/architecture/rewrite-completion-audit.md`
and the test suites it cites, never in the specification itself.

## Staying current: the `asOf` checkpoint

Every module `SPEC.md` (not each component `.spec.md` — see below) opens
with frontmatter recording the commit its specification set was last
confirmed accurate against:

```markdown
---
asOf: <commit-sha>
---
```

`npm run check:specs` diffs each module's directory against its `asOf`
checkpoint (ignoring `.md` files) and reports which modules have drifted.
The [sync-module-specs](../.claude/skills/sync-module-specs/SKILL.md) skill
closes a reported gap: it reads the diff, updates only the specs a real
behavioural change actually affects, and bumps the checkpoint. The check is
deliberately directory-scoped, not file-scoped or component-scoped — a
module page and all its component pages share one checkpoint, because a
review pass reads the module as a whole regardless of which single file
triggered it, and directory scope needs no per-file list to keep up to date
as files are added or removed.

When authoring a brand-new module `SPEC.md`, add this frontmatter with the
commit you're about to author it against (typically the commit you're
committing the spec files in). A component `.spec.md` never carries its own
`asOf` — it's covered by its owning module's checkpoint.

## Why two levels

A module owns a bounded area of behaviour (`work`, `orchestration`,
`execution`, ...). Within a module, individual components — an aggregate, a
projection, a policy/process, an adapter, or a public surface application —
each own a distinct slice of behaviour. The module page is a map: it orients a
reader and explains how its components collaborate. The component page is
where a rule actually lives. A reader should be able to reproduce intended
behaviour from a component page without reading source, and understand how a
module fits into the system from its module page without reading every child.

## Module specification

Ordered sections; omit a heading entirely if it would be empty rather than
keep a placeholder:

1. **Purpose and scope** — why the module exists and what it covers, in a few
   sentences.
2. **Responsibilities and boundaries** — what the module owns, and what it
   explicitly leaves to other modules.
3. **Ubiquitous language** — the terms the module defines, stated precisely
   enough that other specifications can reuse them without redefinition.
4. **Core policies, invariants, and behaviours** — module-wide rules that are
   not specific to a single child component.
5. **Event catalogue** — the module's event types, each with its occurrence
   and business meaning (not its serialization).
6. **Conceptual schema** — one table per key concept (including any child
   entity it contains), with columns Field, Type, Description. Field names
   follow the public contract's naming. Type is the conceptual type (e.g. a
   closed vocabulary's values, an identity kind, "list of `<Entity>`"), not
   the exact TypeScript/Zod declaration. Description states what the field
   means.
7. **Child components and interactions** — a table of the module's behavioural
   owners (aggregate, projection, policy/process, adapter, surface
   application), each linking to its detailed specification where one exists,
   and stating how it uses or produces facts for the others.
8. **Dependencies and system role** — what the module depends on, what
   depends on it, and how it participates in the wider system. List each
   dependency as a bullet, one per item, in the form `Item — reason`: the
   thing depended on (or depending on this module), then why the dependency
   exists.
9. **Decisions, exclusions, and deferred capability** — deliberate scope
   exclusions and capabilities not yet implemented, stated as decisions, not
   as apologies or TODOs.

Keep a module specification below 400 lines. A module page summarises; it does
not repeat a child component's detailed rules — a module with many concepts or
children legitimately runs longer than one with few, but length must come from
covering more distinct things, not from restating a child's detail.

## Component specification

Ordered sections; omit a heading entirely if it would be empty rather than
keep a placeholder:

1. **Type, purpose, and scope** — the component's type (`aggregate`,
   `projection`, `policy/process`, `adapter`, or `surface application`), and
   what it is responsible for.
2. **Ubiquitous language** — terms this component defines or uses precisely,
   beyond what the owning module page already established.
3. **Responsibilities and boundaries** — what the component owns and what it
   explicitly does not do.
4. **Core policies, invariants, and behaviours** — the component's rules,
   stated as concise conditional requirements (`MUST`, `MUST NOT`, `SHOULD`,
   `MAY`), not as narrative process description. For state-changing
   behaviour, state acceptance, rejection, duplicate, and ambiguity semantics
   wherever they apply. For a projection, state its source facts, derived
   meaning, and rebuild expectation. For an adapter, state translation,
   idempotency, and external-effect boundaries.
5. **Event catalogue** — the events this component emits or reacts to, each
   with its occurrence and business meaning.
6. **Conceptual schema** — one table per durable or derived entity the
   component owns (including any child entity), with columns Field, Type,
   Description. Field names follow the public contract's naming. Type is the
   conceptual type, not the exact TypeScript/Zod declaration. Description
   states each field's meaning and, where relevant, its lifecycle.
7. **Dependencies and system role** — what this component depends on inside
   and outside its module, and who depends on it. List each dependency as a
   bullet, one per item, in the form `Item — reason`: the thing depended on
   (or depending on this component), then why the dependency exists.
8. **Decisions, exclusions, and deferred capability** — deliberate scope
   exclusions and capabilities not yet implemented.

Keep a component specification below 250 lines. Split a component
specification only when its conceptual behaviour cannot be understood at that
length — do not split it to shorten the file for its own sake.

## Allowed component types

- **aggregate** — an identity-bearing stream owner that accepts commands,
  enforces invariants, and produces the events that are the durable record of
  its own history.
- **projection** — a pure, rebuildable fold of events into read-optimised
  state. Never a source of truth.
- **policy/process** — deterministic decision logic that reads state (and
  sometimes coordinates other components) without itself owning a stream.
- **adapter** — a translation boundary to something outside the module's own
  domain (an external provider, another module's public contract, IO).
- **surface application** — the public entry point through which commands and
  queries reach the module's behaviour (CLI, HTTP API, or an equivalent
  application boundary).

## Wording rules

- Use `MUST` / `MUST NOT` for requirements the system has to satisfy for
  correctness. Use `SHOULD` for a strong default that has a legitimate,
  named exception. Use `MAY` for genuinely optional behaviour. Do not use any
  of the four where plain descriptive prose already conveys the same
  information unambiguously — reserve them for the requirement-bearing
  sentences.
- Prefer short conditional rules ("When X, the system MUST Y") over narrative
  descriptions of how a request flows through the code.
- Compare closed concepts (statuses, outcomes, relation kinds, event types)
  by name, the same way production code does — never invent a synonym for a
  vocabulary value that already exists in the public contracts.
