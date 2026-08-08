# Agent prompt context: ticket/comment history — design

## Goal

`E2E-DARKFACTORY-001`'s (2a) "implement tries again with context of the
rejection message" doesn't hold today: a retried `implement` activation is a
genuinely fresh agent session (`docs/superpowers/specs/2026-08-08-watch-
gate-github-verdict-channel-design.md` confirmed `sessionId` is only ever a
run's *output*, never fed back as input), and `agent-activity.ts`'s template
rendering context is just `{workItemId}` — no comment or ticket data at all.
This is the design for closing that gap: giving every agent activation the
correlated resource's full comment history and issue title/body in its
prompt-rendering context.

**Explicitly not this design's scope: session resume.** Legacy (`src/
adapters/claude/claude-runner.ts:337-339`, mirrored across all three real
runners via `RunnerCliAdapter.buildResumeCommand`) already has a complete,
working session-resume mechanism, and src-next already has the seam for it
(`RunnerRequest.resumeSessionId`, already wired end-to-end for Codex). It's a
genuinely separate piece of work — captured under "Deferred" below, not
designed here. This design covers only: a fresh session, given full context.

## Scope, deliberately narrowed to what the six scenarios need

No delta/"new since last handled" cursor tracking, unlike legacy. That
distinction existed specifically to keep a *resumed* session's prompt small
(only the delta, since the session already remembers everything else) — with
resume out of scope, every activation is fresh, so it needs the *full*
history every time; there's nothing to compute a cursor against.

**Universal, not opt-in.** Every agent activation gets comments/issue
context available in its template-rendering context, matching legacy's
default. A `refine` stage on a brand-new ticket just gets an empty comment
list — harmless. Whether a given prompt template actually renders this data
is a prompt-authoring choice, not an engine-level toggle.

## Architecture

`CommentObserved` events (`integration.github.comment-observed`) already flow
through the generic adapter-polling path (`PollService.pollOnce` →
`journal.append`) and land durably in the journal today — confirmed; this is
not new ingestion work. The gap is entirely on the read side: nothing folds
them into a per-resource, queryable comment list.

1. **New read-side capability**, provider-agnostic at the interface Wake's
   activity layer depends on (matching CLAUDE.md's pluggable-architecture
   rule: activities stay provider-agnostic even though the concrete
   implementation is GitHub-specific for now) — an interface returning a
   resource's comment history (author, timestamp, body), resolved from a
   work item via Resources' existing `correlationsForWork`, filtered to the
   `ResourceCorrelationRole.Primary` correlation (matching
   `AgentRunPublicationReactor`'s own existing precedent for resolving "the"
   resource a work item's own comment should target), decoded from that
   resource's own `integration.github.*` stream.
2. **`agent-activity.ts` gains a second injected dependency**, alongside the
   existing `templates: AgentTemplateRenderer`, wired the same way in
   `composition-root.ts`. Before calling `render(name, context)`, the
   activity fetches the correlated resource's comments/issue title+body and
   adds them to `context` — every template gets this, always, matching the
   `AgentTemplateRenderer` seam exactly rather than inventing a new one.
3. **No bot-comment filtering.** Legacy excludes Wake's own bot-authored
   comments from the injected list by default (so an agent doesn't mistake
   its own prior status post for a new instruction), with a deliberate
   exception for a bot comment on a *correlated* PR/review surface — because
   that's specifically how the "revise" trigger worked there. This design
   skips that nuance entirely: the injected block is framed as untrusted
   context, not instructions (see below), which covers the main risk legacy
   was guarding against without needing the bot/human distinction, and — for
   this design's actual purpose — the rejection feedback that 2a needs
   *is* a bot-authored comment (Wake's own `AgentRunPublicationReactor`
   output), so filtering it out by default would defeat the point. Captured
   as a deferred refinement below, not a blocker.
4. **Untrusted-context framing, reused from legacy's proven pattern**
   (`stage-prompt.ts`'s `buildUntrustedDataBlock`): issue title, body, and
   the full comment list are wrapped in a delimited block stating plainly
   that this is context, not instructions, and the harness prompt tells the
   agent not to follow commands embedded in it. Worth porting verbatim in
   spirit — it's a real, working mitigation for exactly the risk untrusted
   ticket content poses, not something to redesign from scratch.

## Testing

- Unit test for the new comment-history reader: given a resource's own
  `CommentObserved` events in the journal, returns them decoded and ordered.
- Unit test for `agent-activity.ts`'s context enrichment: a template's
  `render` call receives comments/issue data alongside `workItemId`; a work
  item with no correlated resource, or a resource with no comments yet, gets
  an empty list, not an error.
- E2E: extend `E2E-DARKFACTORY-001` (already spawns a real `pr-review`
  child per the earlier follow-up work) to assert the retried `implement`
  activation's own rendered prompt/context actually contains the prior
  rejection's `displayBody` text — proving the scenario's own stated
  requirement, not just that the mechanism exists in isolation.

## Deferred, captured now, not designed here

- **Session resume** (see Goal). Legacy's full mechanism already exists as
  precedent: durable `sessionId`/`sessionCli` tracking per work item+action,
  cleared on forward-stage-transition/`FAILED`, `isResume` decided by same
  CLI + existing session, `RunnerRequest.resumeSessionId` already wired for
  Codex (needs the same for `claude.ts`/`cursor.ts`). Whether `watchGate`'s
  reject-retry loop should ever use resume (vs. always-fresh, which this
  design already provides) is an open question for that follow-up, not
  answered here.
- **Bot-comment filtering / "new since last handled" distinction.** Only
  matters once resume exists (to keep a resumed prompt's delta small) or if
  full-history noise becomes a real problem — revisit then, not now.
- **Review-comment-surface tracking** (legacy's `reviewCommentApiId`,
  correlating a comment back to a specific PR review thread/line) — not
  needed for any of the six scenarios; legacy's own comment is that "surface
  API composits" a synthetic id for this, non-trivial, and out of scope here.
