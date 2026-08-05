# External close concludes work item design

## Goal

When the ticket backing a work item is closed on its external tracker — a
GitHub issue closed as completed or as not planned, today; a Jira issue
resolved or cancelled, in a future adapter — Wake concludes the matching
work item the same way, stopping any in-flight execution instead of leaving
it to run against a ticket nobody is tracking anymore. The mapping must not
depend on inferring *why* GitHub auto-closed something, and the vocabulary
crossing out of the GitHub adapter must be provider-neutral.

## Removing the auto-close ambiguity

Today `prompts/implement.md` explicitly instructs the agent to write
`Closes #{{issueNumber}}` in its PR body (`implement.md:24`, `:50`), which is
GitHub's keyword for "close this issue when the PR merges into the default
branch." That makes an issue's closure ambiguous after the fact: was it
closed because a human decided the work item was done, or as a side effect
of a PR merging that Wake may still have follow-on stages for (review,
verify) before the work item should conclude?

Rather than inferring cause from a closed issue, the design removes the
ambiguity at the source: both instructions change to a non-magic reference
(`Refs #{{issueNumber}}`). GitHub then never auto-closes an issue Wake is
tracking. Every future `issue closed` observation is therefore either Wake
closing it itself as the last step of a completed workflow, or a human
closing it deliberately (including "not planned"). Both are legitimate,
unambiguous signals to conclude the work item.

## Provider-neutral outcome vocabulary

`integrations/contracts/` gains a closed vocabulary describing how an
external resource concluded, reusing the same words as the existing
`WorkStatus` terminal states it maps onto rather than inventing a synonym:

```ts
export const ExternalWorkOutcome = defineClosedVocabulary({
  Completed: 'completed',
  Cancelled: 'cancelled',
} as const);
```

Each adapter translates its own provider semantics onto this at its own
boundary. For GitHub, `issue-source.ts` maps the issue's `state_reason`
(`"completed"` → `Completed`, `"not_planned"` → `Cancelled`) when
`state` is `Closed`; `GitHubIssuePayload` and `payloads.ts` gain
`state_reason`, threaded from wherever issue payloads are currently read.
No GitHub-specific value (`state`, `state_reason`) is ever read outside the
`integrations/github` package — everything downstream sees only
`ExternalWorkOutcome`. A future Jira adapter maps its own resolution field
the same way, with no changes required outside `integrations/jira`.

## Conclusion cascade

`control-plane/application/work-cancellation-policy.ts` already has the
right shape for this — cancel every active Run of the work item's
workflows, then block each of those workflows — but is hard-wired to
`work.cancel`. It generalizes to accept an `ExternalWorkOutcome` and call
`work.close` (`Completed`) or `work.cancel` (`Cancelled`) as its first step,
sharing the rest of the cascade unchanged: both outcomes mean the work item
is no longer live, they only differ in the terminal `WorkStatus` and the
recorded reason text. This cascade is implemented but has no production
caller today (its own spec notes an operator-facing cancel command as a
"would-be dependent, none of which composes this policy today"); this
becomes its first caller.

## Adapter-agnostic reactor

`integrations/application/work-admission.ts` is the existing pattern for
this seam: an adapter-specific translator (`InboundTranslator.apply()`)
calls into shared, adapter-neutral logic for the generic "this observation
changes Wake's work" behavior. A sibling `work-conclusion.ts` adds
`concludeObservedWork(services, { workItemId, outcome }, context)`,
composing the generalized cascade above.

`InboundTranslator.apply()`'s existing revision-change branch
(`inbound-translator.ts:164-184`, which already runs when a previously-seen
resource's revision changes) is extended: after re-discovering the
resource, if the observed payload carries a closed `ExternalWorkOutcome`,
call `concludeObservedWork`.

## Idempotency

`concludeObservedWork` checks the current `WorkItemView.state === Open`
before calling `close`/`cancel`, and no-ops otherwise, rather than relying
on `WorkService.change()`'s throw-on-non-Open guard. This keeps the
inbound-translator's event loop from crashing on any of: replaying the
journal, duplicate polls observing the same closed state twice, or Wake's
own close echoing back through the next GitHub poll as a revision change.

## Deferred: reopening

Reopening the external ticket does not currently recover the work item.
`WorkService.change()` rejects every command once a work item leaves
`Open` (`work-service.ts:38`), and `WorkEventType` has no `ItemReopened`
event. Adding it is a separate design problem, not a small extension: it
has to define what happens to the Runs the conclusion cascade already
cancelled and the workflow instances it already blocked (resume in place,
or restart the workflow from scratch?), and orchestration's existing
`resume` transition concept is scoped to workflows blocked on things like
approval-waiting, not to "blocked because the work item concluded" — reusing
it here needs its own check that the semantics actually fit. Until that
design exists, closing/cancelling a work item is a one-way terminal move,
matching today's behavior; a human who reopens the ticket must re-trigger
the work some other way.

## Testing

- Unit: `ExternalWorkOutcome` mapping from GitHub `state`/`state_reason`
  combinations (open, closed+completed, closed+not_planned) in
  `issue-source.ts`.
- Unit: the generalized conclusion cascade calls `close` vs `cancel`
  correctly per outcome, and still cancels active Runs and blocks workflows
  for both.
- Unit: `concludeObservedWork` no-ops when the work item is already
  non-`Open`.
- Composed/E2E: an issue observed, admitted, and worked, then closed as
  completed, concludes the work item as `Closed`, cancels its active Run,
  and blocks its workflow instance; the same scenario closed as not planned
  concludes it as `Cancelled`. A duplicate observation of the same closed
  state is a no-op. Replaying from a fresh projection reproduces the same
  end state.
- Prompt content: `implement.md` no longer contains a GitHub closing
  keyword.

## Documentation

`docs/workflows.md` gains a note that Wake concludes a work item when its
source ticket closes (mapped to closed/cancelled by outcome), and that PR
bodies reference rather than close the ticket so merge and ticket-closure
stay independent signals.
