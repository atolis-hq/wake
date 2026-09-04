# conversations

## Purpose

Canonical, provider-neutral WorkItem discussions.

## Owns

Conversation streams, immutable entries, revisions, and projections.

## Does not own

Provider evidence, delivery targets, workflow transitions, or execution.

## Event publishing

Conversations owns its event types, payload map, conversation stream reference,
selector/decoder, and `createConversationEventData` factory. It creates
immutable event data and appends non-empty expected-sequence batches; the
journal creates the recorded envelope.
