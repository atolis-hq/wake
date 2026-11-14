# Configurable ticket intake policy: assignee matcher

## Problem

`docs/todo/configurable-ticket-intake-policy.md` asks for a configurable policy
governing which ticket state Wake will pick up, with "assigned to a user" and
"has a label" given as example matchers.

Label matching already exists: `config.sources.github.policy.requiredLabels` /
`ignoredLabels`, enforced in `policy-engine.ts`'s `isEligible()`. The gap is
assignee matching — `IssueStateRecord.issue.assignees: string[]` is already
populated from GitHub (`github-issues-work-source.ts`) but unused by policy.

## Design

Add one field to the existing `policy` config object rather than building a
new generic matcher framework (todo's examples are fully covered by
label + assignee; a pluggable matcher list would be speculative for a
two-matcher policy):

```ts
policy: z.object({
  requiredLabels: z.array(z.string()),
  ignoredLabels: z.array(z.string()),
  requiredAssignees: z.array(z.string()), // new
}),
```

Identity: entries are GitHub **logins** (usernames, e.g. `"octocat"`), not
numeric user IDs or emails — this matches what's already extracted from the
GitHub API and stored on `IssueStateRecord.issue.assignees`
(`github-issues-work-source.ts:57-59` takes `assignee.login`, discarding the
numeric `id` GitHub also returns).

Semantics, matching the existing `requiredLabels` convention:

- Empty array (default) = no restriction.
- Non-empty = ticket must be assigned to **at least one** (OR) of the listed
  GitHub logins. (Assignee is naturally OR-of-list; `requiredLabels` is
  AND-of-list because a ticket needs every required label — these are
  different semantics for good reason and both are precedented by the
  existing label design.)
- Combined with label matchers using AND (all configured matchers must pass).

### Recheck scope

Same as the existing label policy: `isEligible()` is called every tick
(`tick-runner.ts`), gating both initial pickup and continued work. If a
ticket is reassigned away from the required user mid-flight, Wake stops
acting on it, consistent with today's label behavior. No special-casing for
"first pickup only."

## Changes

1. `src/domain/schema.ts` — add `requiredAssignees: z.array(z.string())` to
   the `policy` schema object.
2. `src/config/defaults.ts` — default `requiredAssignees: []`.
3. `src/core/policy-engine.ts` — in `isEligible()`, after the label checks:
   if `requiredAssignees` is non-empty and none of `issue.issue.assignees`
   appear in it, return `false`.
4. `docs/configuration.md` — add a `requiredAssignees` row to the `policy`
   table (same section as `requiredLabels`/`ignoredLabels`).
5. Tests — new `test/core/policy-engine.test.ts` (no test file currently
   exists for this module) covering `isEligible()`:
   - no assignees configured → eligible (pass-through)
   - configured, issue assigned to a listed user → eligible
   - configured, issue assigned to a non-listed user only → ineligible
   - configured, issue has no assignees → ineligible
   - combined with `requiredLabels`/`ignoredLabels` → AND semantics

## Out of scope

- No changes to `WorkSource`, GitHub adapter, or fake ticketing system —
  assignees are already ingested end-to-end.
- No generic/pluggable matcher framework.
- No change to when policy is (re)checked (every tick, same as today).
