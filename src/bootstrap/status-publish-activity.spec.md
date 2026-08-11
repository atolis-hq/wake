# Status-publish built-in activity — Component Specification

## Type, purpose, and scope

Adapter. The status-publish built-in activity is the `status.publish`
Activity: a deterministic, always-available workflow step that requests a
status update be delivered on a resource, by appending a delivery-intent
fact to that resource's own stream.

## Responsibilities and boundaries

This component owns accepting a status-publish invocation, validating its
input shape, and appending the corresponding delivery-intent fact. It does
not own delivering the update to any external system — that is the
delivery-intent fact's own downstream handling, owned by Integrations — and
it does not decide when a workflow should call it; that is Orchestration's
concern.

## Core policies, invariants, and behaviours

- Input MUST be a single non-empty `body` string; no other input shape is
  accepted.
- Invocation MUST be bound to at least one resource; the first bound
  resource is treated as the update's target. Invoking this activity with no
  bound resource MUST fail.
- On success, this activity MUST append exactly one delivery-intent fact to
  the target resource's own stream, at that stream's current length,
  carrying the invoking workflow instance id, activation id, the target
  resource id, and the given body unchanged.
- The appended fact's identity MUST be derived from the invoking activation
  id, not freshly minted per call, so repeated invocations for the same
  activation address the same fact identity rather than each minting an
  unrelated one.
- This activity MUST always report a deterministic `Done` outcome on
  success; it has no other outcome kind and is not itself capable of
  reporting that delivery failed — only that a delivery was requested.

## Event catalogue

| Event | Occurs when | Business meaning |
| --- | --- | --- |
| `status.publish-requested` | This activity completes successfully | A status update has been requested for delivery on the named resource; ownership of this event type and its schema belongs to Integrations, not to this component. |

## Dependencies and system role

- Integrations — owns the `status.publish-requested` event type and its
  schema, and owns everything that happens to the fact once appended
  (matching it to a delivery, delivering it, recording the outcome).
- Resources — owns the target resource's own stream this activity appends
  to; this component addresses that stream by the resource id bound to its
  invocation.
- Activity registry (depends on this component) — the composition root
  registers this activity so it is available to every configured workflow
  without further operator configuration.

## Decisions, exclusions, and deferred capability

- This activity is deterministic and has exactly one outcome kind; it does
  not support a workflow author configuring a different outcome shape or a
  richer message than a plain body string.
