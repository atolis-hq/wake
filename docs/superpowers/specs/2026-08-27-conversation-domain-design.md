# Conversation domain design

## Decision

Wake will introduce `conversations` as a first-class bounded module. It owns
the canonical, durable discussion record for a WorkItem: conversation identity,
immutable entries and revisions, projections, and read APIs. The Conversation
service is the sole producer of `conversation.*` facts. Provider adapters,
agent activities, and the control-plane UI submit attributed entry commands to
that service.

Version one deliberately has one active Conversation per WorkItem. A
Conversation is created with its WorkItem and has a required WorkItem link.
Conversations that exist before a WorkItem, or that split into many WorkItems,
are deferred. The Conversation identity and relation-based model leave room to
relax that constraint later without replacing the data model.

## Why this is a bounded module

Today GitHub-specific code re-folds `integration.github.comment-observed`
evidence and confirmed delivery facts into an agent context. That is useful
evidence, but it cannot be the shared, provider-agnostic conversation required
for multiple adapters, a unified UI view, control-plane authored messages, or
cross-surface policy.

`conversations` makes the thing people experience as the discussion a
canonical, rebuildable domain fact while retaining provider evidence as the
auditable source record for its adapter. It does not own provider polling,
thread formats, delivery targets, workflow transitions, or agent execution.

## Ownership and dependencies

| Module | Responsibility |
| --- | --- |
| `conversations` | Conversation IDs, streams, entries, revisions/tombstones, participating resource/thread links, projections, context reads. |
| `integrations` | Provider polling and validation, raw evidence, provider-neutral external-entry commands, external message/thread IDs, delivery, echo reconciliation, and configuration for publication targets. |
| `activities` | Reads stage-relevant conversation context to render an agent prompt. |
| `orchestration` | Continues to apply configured workflow transitions and does not acquire a dependency on conversation or resource concepts. |
| reaction bridge | Applies existing state-aware reply rules to a recorded conversation entry and produces the ordinary workflow signal or no-op. |
| `surfaces` | Presents a unified timeline and records operator-authored entries through application services. |
| `bootstrap` | Composes services and registers Conversation projections. |

The Conversation module may refer to a WorkItem and resource/thread reference,
but it does not know provider-specific resource kinds or publication policy.
Provider-specific external identifiers are carried as opaque adapter-owned
references.

## One entry command boundary

All entry sources converge on the Conversation service. They do not construct
or append Conversation event drafts themselves:

```text
GitHub or Slack adapter -> validated external-entry command --+
control-plane UI       -> control-plane-entry command        +-> Conversation service
agent/run reactor      -> agent-entry command                +-> conversation.entry-recorded
Wake system reactor    -> system-entry command               +
```

An external adapter first records its own raw evidence, then its integration
translator maps the validated provider payload to a provider-neutral external
entry command. The Conversation service owns command validation, idempotency,
and the event factory. It never decodes provider-specific event payloads.

The command's provenance is discriminated by source: external entries carry an
adapter and source resource/thread/message references; control-plane entries
carry an authenticated operator/session; agent entries carry run and stage;
and system entries carry their causal workflow or activity fact. This is one
domain mechanism with several trusted producers, not a second internal adapter
mechanism.

## Data model

### Conversation

Each Conversation has a Wake-owned ID and exactly one required `workItemId` in
v1. Its projection lists participating resources/threads and its ordered
entries. A resource can participate in a conversation without being the
origin of every entry.

### Conversation entry

An entry is immutable and contains:

- Wake occurrence time and journal position;
- text and actor;
- origin: GitHub, Slack, control-plane, or agent;
- optional source resource/thread and provider-message reference;
- optional workflow stage and run ID;
- an untrusted classification for externally supplied content.

An external edit or deletion is represented by an appended revision or
tombstone fact. The projection exposes the latest visible content while
retaining the full audit trail. Journal ordering is authoritative for
deterministic reconstruction; provider timestamps are display metadata.

### Three separate links

The design keeps these facts separate:

1. **Entry source resource:** where an externally observed message originated.
2. **Conversation-resource association:** a resource/thread participating in
   the shared discussion.
3. **Delivery target:** where an integration decided to publish a copy of a
   Wake-authored entry.

This allows the UI to state, for example, that a message originated in the
control plane and was mirrored to GitHub. It also prevents the accidental
first-primary-resource routing currently identified by issue #755.

## Inbound and outbound flow

### Inbound provider message

1. An adapter polls and validates provider data, then records its normal raw
   integration evidence.
2. Its integration translator resolves the participating resource/thread and
   submits one provider-neutral external-entry command with source provenance.
3. The Conversation service validates it and records one canonical Conversation
   entry.
4. The reaction bridge evaluates the entry with the existing state-aware
   workflow reply rules.

### Wake, agent, or control-plane message

1. A UI, agent/run, or Wake-system producer submits its attributed entry command
   and the Conversation service records the canonical entry first.
2. Integrations may select zero or more publication targets from their own
   configuration and create durable delivery intents referencing that entry.
3. Delivery confirmation, reconciliation, or an observed echo attaches an
   external representation/proof to the existing entry. It never adds a
   duplicate conversation message.

Conversation entries contain no publication targets. This preserves the
boundary that adapters decide what to publish and where.

## Reaction and context policy

Recording an entry never itself decides a workflow transition. The
provider-neutral reaction bridge applies the existing state-aware rules that
already distinguish commands, natural replies, and no-ops.

A control-plane-authored entry is treated as a human reply on the WorkItem's
active Conversation. If the current stage has an agent activity able to accept
the reply, Wake creates the ordinary follow-on activation. Execution retains
its existing responsibility for choosing whether to start or resume the
related session. If the stage has no associated agent activity, the entry is
durably recorded but is a no-op for workflow advancement.

The initial agent context policy preserves current behaviour: activities render
the complete stage-relevant conversation history into the prompt. All external
content retains untrusted-context framing. Targeted agent retrieval tools and
more selective context policies are deferred until the canonical reader is in
place.

## Publication and privacy

Adapters own publication rules. They may match entry origin/type, workflow,
stage, and outcome to choose a linked resource/thread, suppress delivery, or
later fan out to multiple surfaces.

Cross-surface publication is opt-in. In particular, content from a private
surface such as Slack must not be mirrored to a public GitHub resource by
default. Delivery records retain the adapter's external message/thread IDs so
it can reconcile its own echoes and scope eligible replies correctly.

## Control-plane UI

The first UI surface is a read-only timeline on the WorkItem detail view. Each
entry displays text, actor, origin, timestamps, optional stage/run attribution,
and links to the source resource and detailed agent transcript when available.
It is the human-facing narrative; raw event views and detailed execution
transcripts remain available for diagnostics.

A subsequent, small slice adds a control-plane send-message command. It
records an attributed operator entry, invokes the reaction bridge, and only
publishes externally when integration configuration permits it.

## First implementation slice

1. Add `conversations` streams, facts, services, projections, identifiers, and
   public module contracts.
2. Compose the module in Bootstrap and have GitHub create canonical entries in
   addition to its raw provider evidence.
3. Replace the GitHub-specific agent-context read with the provider-neutral
   Conversation reader while retaining full stage-filtered prompt context.
4. Expose a read-only conversation API and timeline in the control-plane UI.
5. Add the control-plane message command and reaction bridge after the read
   path is proven.

There are no active WorkItems in the only active Wake home, so v1 requires no
backfill. Existing historical journal data remains untouched.

## Verification

Tests must prove:

- event decoding, stream validation, projection rebuilds, ordering, revisions,
  and tombstones;
- source-resource and participating-resource/thread links;
- one provider observation maps to one canonical entry, while delivery echoes
  reconcile with it rather than duplicating it;
- full, stage-relevant prompt context preserves untrusted framing;
- state-specific reply handling triggers the expected activation, while a stage
  without an agent activity is a durable no-op;
- conversation API/UI source and attribution rendering;
- an end-to-end GitHub scenario from inbound comment through canonical timeline
  and agent context.

## Deferred

- Conversations before WorkItems and one conversation creating or relating to
  multiple WorkItems.
- Slack implementation, multi-surface fan-out, and configurable publication
  rules.
- Agent-directed history retrieval and advanced context selection.
- Incorporating full internal agent transcripts into the conversation timeline.
- Historical backfill.
