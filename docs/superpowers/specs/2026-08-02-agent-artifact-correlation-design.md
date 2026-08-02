# Agent-reported artifact correlation — design

Status: approved, ready for implementation planning.
Supersedes: none. Implements `docs/adrs/0001-correlating-external-resources-to-work-items.md`
flow 2 (`§3.2`) for `src-next`, amended 2026-08-02 (see that ADR's amendment
section) to narrow its conflict-handling for this flow specifically.

## Problem

Traced the end-to-end GitHub-surface loop (issue → WorkItem → workflow →
agent run → PR → review → merge) in `src-next` and found it doesn't close:
an agent that creates a PR during implementation has no path for that PR to
be correlated back to the WorkItem whose workflow produced it. `src-next`
has zero references to ADR 0001's registration mechanism — no artifacts
parsing, no verification step, no registration event — while legacy `src/`
has all of it built. Traced the concrete consequence:
`activities/agent/agent-result.ts`'s outcome schema has no structured field
for a reported artifact, and `integrations/github/application/inbound-translator.ts`'s
`resolveIdentity` mints a brand-new, unrelated WorkItem for any first-seen
external key rather than linking it back — so a freshly agent-created PR
either gets silently dropped by intake rules or spawns a second, disconnected
WorkItem. Every downstream PR-review/approve/merge behavior assumes a PR is
already correctly correlated; none of it matters for an agent-created PR
until this exists. Filed as finding X1 in
`docs/reports/2026-08-02-target-architecture-spec-findings.md`.

## Decisions

- **Verify before trusting.** An agent-reported artifact is a claim, not a
  fact, until Wake confirms it against the provider (resolves the locator to
  a live resource, checks its branch matches the run's workspace branch).
  Matches ADR 0001 flow 2 and legacy's actual behavior.
- **Correlation gains a `provenance` field.** `resources.work-correlation-established`
  records how the correlation was learned: `agent-reported` for this flow
  (alongside `provider-observed` and `operator-declared` for the existing
  flows). Cheap to add now, valuable for debugging "why does Wake think this
  belongs here," and matches what the ADR already designed but `src-next`
  never implemented.
- **Provider-generic, not GitHub-hardcoded.** `resources`' existing
  primitives are already provider-neutral (`resourceKind`/`resourceCapability`
  are open, extensible registries; `externalKey: { adapter, key }` already
  decouples Wake's `resourceId` from any provider's locator format) — so a
  reported artifact reuses those types directly: `{ kind: ResourceKind,
  externalKey: ExternalResourceKey }`, not a parallel URI grammar.
- **"Artifact" and "resource" are deliberately different words for
  different trust states.** An artifact is the agent's unverified claim,
  durably visible the moment the outcome is accepted, independent of
  whether it's ever confirmed. It only becomes a Resource once
  `verifyArtifact` succeeds and `resources.discover` is called on it. This
  matches the ADR's own vocabulary.
- **Artifacts are reported independent of outcome kind.** `reportedArtifacts`
  can appear on `DONE`, `BLOCKED`, or `FAILED` outcomes alike — a PR the
  agent pushed before getting blocked or failing partway through is still
  real, external state that would otherwise go untracked, which is exactly
  the failure mode this design exists to close.
- **A primary conflict on a flow-2 artifact never auto-folds to `secondary`,
  and `secondary` is not a valid outcome for this flow at all.** See the
  ADR amendment for the full reasoning: a conflict here signals an anomaly
  Wake itself is responsible for (stale branch, duplicate dispatch,
  misreported locator), not the ADR's legitimate multi-issue-PR case, and a
  flow-2 artifact is scoped to the one WorkItem whose run produced it, so it
  has no legitimate secondary target to begin with. Resolution is always
  deliberate operator action (flow 3), never an automatic guess.
- **Verification failure is two different states, not one.** A provider-
  confirmed negative (not found, branch mismatch) is permanent — record and
  move on, retrying changes nothing. A transient failure (network, rate
  limit) is `ambiguous` — genuinely unknown, worth retrying later. Reuses
  the `ambiguous` vocabulary already established three times in this
  codebase (`IntentAppendStatus`, `ActivityRunnerTransportStatus`, delivery's
  own outcome vocabulary) rather than a new synonym.
- **The reactor never blocks its own checkpoint on a retryable item.** These
  reactors process one checkpoint position, strictly in order; not
  advancing past a stuck item stalls every artifact after it in the entire
  integration stream, not just the stuck one — the same head-of-line-
  blocking failure already flagged as finding I4 (GitHub delivery
  `reconcile()` looping forever on `Unknown`). Retry for `ambiguous` items is
  a separate, periodic reconciliation sweep, mirroring `integrations/delivery`'s
  existing reconcile-before-retry shape, not a stalled checkpoint.

## Architecture

**New/changed pieces:**

1. `activities/agent/agent-result.ts` — `agentActivityOutcomeSchema`'s
   structured result (any kind: `DONE`/`BLOCKED`/`FAILED`) gains an optional
   `reportedArtifacts: readonly { kind: ResourceKind, externalKey:
   ExternalResourceKey }[]`, validated shape only. Malformed entries are
   dropped with a recorded notice; they never fail the outcome itself.
2. `integrations/contracts/provider.ts` — the provider contract gains
   `verifyArtifact(kind, externalKey, context: { workspaceBranch }):
   Promise<VerifiedArtifact | 'not-found' | 'ambiguous'>`. Each
   `ProviderDefinition` (github, fake) implements it.
3. `integrations/github/...` — implements `verifyArtifact` for
   `kind: 'pull-request'`: resolves the PR via the REST client, confirms
   its head branch matches `workspaceBranch`.
4. `integrations/fake/...` — the matching fake implementation, per the
   existing permanent-test-harness convention.
5. New reactor, `integrations/application/artifact-registration-reactor.ts`
   — same checkpoint-driven journal-scan shape as `delivery-outcome-reactor`/
   `watch-reactor`. Watches `orchestration.activity-outcome-accepted`; for
   each outcome carrying `reportedArtifacts`, resolves the artifact's
   provider via `ProviderRegistry`, calls `verifyArtifact`, and:
   - verified → `resources.discover` + `resources.correlate(..., 'primary',
     { provenance: 'agent-reported' })`; a thrown primary-conflict is caught
     (not retried, not folded to secondary) — the durable
     `resources.work-correlation-conflicted` fact `resources` itself already
     records is the resolution record;
   - confirmed negative → record `integration.artifact-verification-unresolved`
     with `status: 'failed'` on the integration stream, checkpoint advances;
   - transient failure → record the same event with `status: 'ambiguous'`,
     checkpoint advances regardless.
6. New periodic reconciliation sweep (mirrors `integrations/delivery`'s
   existing reconcile-before-retry mechanism) — reads `ambiguous`-status
   `artifact-verification-unresolved` facts, retries verification, and either
   promotes to registration, flips to `failed`, or leaves `ambiguous` for
   the next sweep, up to the bounded attempt count decided in
   `docs/superpowers/specs/2026-08-02-ambiguous-state-escalation-design.md`;
   past that count it uses that design's Integrations escalated-marker
   mechanism (the same one delivery reconciliation, finding I4, now uses)
   rather than a third bespoke mechanism.
7. `resources.work-correlation-established` payload gains `provenance`.
8. Bootstrap wires the new reactor and sweep into the same composition
   points as the existing reactors.

**Data flow:**

1. Agent finishes work, pushes a branch, runs `gh pr create`, and its
   structured result includes `reportedArtifacts: [{ kind: 'pull-request',
   externalKey: { adapter: 'github', key: '<owner>/<repo>#<number>' } }]`
   alongside whatever outcome kind actually happened.
2. `translateAgentResult` validates it into the outcome — no change to
   Execution or Orchestration; both carry `data` through opaquely, exactly
   as today.
3. Orchestration accepts the outcome and durably records it in
   `activity-outcome-accepted`, `reportedArtifacts` included verbatim.
4. The new reactor picks it up on its next scan, verifies against the
   declared provider, and registers the correlation (or records the
   unresolved/conflict fact).
5. If `ambiguous`, the periodic sweep retries later, independent of the
   main reactor's own progress.

## Testing

- Unit: `verifyArtifact` (github) — verified success, confirmed not-found,
  branch mismatch, transient/ambiguous error.
- Unit: the reactor, one case per branch — verified→registered;
  malformed artifact→dropped, outcome still processed; confirmed
  negative→`failed` fact, checkpoint advances; transient→`ambiguous` fact,
  checkpoint advances (explicitly assert the *next* item in the same batch
  still processes, proving no head-of-line blocking); primary
  conflict→caught, no throw escapes, no secondary fallback attempted.
- Unit: the reconciliation sweep — retries an `ambiguous` fact and promotes
  it on success.
- E2E (fake provider, composed production services — not a mocked
  shortcut): a fake agent run reports a fake-provider PR artifact; the
  reactor verifies it via the fake provider; the resource is discovered and
  correlated as primary; the work-detail surface reflects it. A second
  scenario drives the conflict path: two runs report the same fake artifact
  for different WorkItems; the second is caught, the conflict fact is
  durable and visible, no correlation is silently guessed.

## Deferred / out of scope

- Flows 1 (Wake-created artifacts, e.g. a future adapter opening a PR
  directly) and 3 (detected/operator-declared) are unaffected by this
  design and remain as the ADR describes them.
- Bounded retry/escalation for `ambiguous` items is settled in
  `docs/superpowers/specs/2026-08-02-ambiguous-state-escalation-design.md`
  (also covers findings E1/E6 and I4) — this spec consumes that design
  rather than re-deriving it.
- Non-PR artifact kinds are supported by the schema shape but have no
  provider implementing `verifyArtifact` for them yet; nothing in this
  design blocks adding one later.
