---
name: sync-module-specs
description: Use when asked to update, refresh, or sync the src-next module specifications (SPEC.md / *.spec.md), when npm run check:specs reports a module as stale or unchecked, or before trusting that a spec still describes current behaviour. Do not use for authoring specs for a module that has none yet — that's the original authoring pass documented in src-next/SPECIFICATION.md, not a sync.
---

# Sync Module Specs

## Overview

Every module under `src-next/` has a `SPEC.md` carrying an `asOf: <sha>`
frontmatter checkpoint — the commit its specification set was last confirmed
accurate against. `npm run check:specs` diffs each module's directory
against its checkpoint and reports which modules have non-doc changes since
then. This skill closes that gap: read what actually changed, update only
the specs that need it, and bump the checkpoint.

This is a **targeted re-verification**, not a rewrite. Read `src-next/SPECIFICATION.md`
first if you haven't already — every rule there (MUST/MUST NOT wording,
Field/Type/Description schema tables, `Item — reason` dependency bullets,
line budgets, no test names/scenario IDs/proof links) still applies to any
edit you make here.

## Procedure

### 1. Find what's stale

```
npm run check:specs
```

This lists each module as `Stale` (with its checkpoint sha and the changed
files), `Unchecked` (no valid `asOf` yet — treat as needing a full read, not
just a diff), or `Current` (nothing to do).

### 2. For each stale or unchecked module

Read the actual diff, not just the file list:

```
git diff <asOf-sha> -- src-next/<module>/
```

(For an unchecked module with no sha, just read every source file in
`src-next/<module>/` — you have no baseline to diff from.)

Then read that module's existing `SPEC.md` and every linked `*.spec.md`, and
work out which of three cases each changed file falls into:

- **A change to an existing component's behaviour** — update the relevant
  section(s) of that component's `.spec.md` to match. Don't rewrite
  untouched sections; edit only what the diff actually changed.
- **A genuinely new behavioural owner** (a new aggregate, projection,
  policy/process, adapter, or public surface application that the module
  page's "Child components and interactions" table doesn't already cover) —
  write a new `.spec.md` for it and add its row to that table. Not every new
  file needs a new page (see `src-next/SPECIFICATION.md`'s guidance on what
  counts as a behavioural owner); most new files extend an existing
  component and fall into the case above instead.
- **Pure refactor with no behavioural change** (renamed file, extracted
  helper, reordered imports) — no spec edit needed. Confirm this by reading
  the diff, don't assume it from the file list alone; this is exactly the
  case the directory-level (not file-level) staleness check is expected to
  over-flag.

Also re-check the module `SPEC.md`'s own module-wide sections (Ubiquitous
language, Core policies, Event catalogue, Conceptual schema, Dependencies)
against the diff — a component-level change sometimes changes a module-wide
statement too (e.g. a new event type belongs in both the component's own
Event catalogue and the module page's).

Ground every edit in the code you just read, exactly as in the original
authoring pass — never infer from the old spec text or from memory of what
the module used to do.

### 3. Bump the checkpoint

Once a module's specs are confirmed current against its latest source,
update its `SPEC.md` frontmatter:

```
asOf: <current HEAD sha>
```

Use `git rev-parse HEAD` (or the sha you're about to commit against) — not
the module's own last-changed sha, since the checkpoint means "verified
current as of here," not "last edited here."

### 4. Re-verify and hand off

Run `npm run check:specs` again — every module you touched should now report
`Current`. Do not commit automatically; report what changed and let the
operator review before committing, same as any other spec-authoring pass.

## Scaling to many stale modules

For one or two stale modules, do the above directly in this session. For
several at once (e.g. after a large multi-module PR merges), dispatch one
background subagent per stale module with this same procedure, each scoped
to only its own module directory — this mirrors how the original module
specs were authored and keeps each pass's diff small enough to ground
precisely rather than skimmed.

## What this skill does not do

- It does not author specs for a module that has never had one — that's the
  standard's own authoring process, not a sync.
- It does not resolve the findings already logged in
  `docs/reports/2026-08-02-target-architecture-spec-findings.md` — a stale
  spec and an open behavioural finding are different things. Syncing a spec
  to match current code doesn't mean a finding's underlying gap got fixed;
  don't close a finding just because the spec around it got updated.
- It does not touch `docs/architecture/rewrite-completion-audit.md` or the
  functional-decision catalogue — out of scope for a sync pass.
