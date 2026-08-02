# GitHub Outbound Delivery — Component Specification

## Type, purpose, and scope

Adapter. This component translates a `DeliveryIntentView` into a GitHub API
mutation (approve, merge, or comment) and implements the module's
`ExternalDeliveryAdapter` contract for GitHub-owned resources.

## Ubiquitous language

- **Idempotency marker** — an HTML comment (`<!-- wake:delivery:<intentEventId> -->`)
  appended to every comment/review body this component delivers, carrying
  the intent's own event id.

## Responsibilities and boundaries

This component owns mapping a `DeliveryIntentView`'s kind to a GitHub
action (approve, merge, status comment, reply comment), building the
GitHub API call from the intent's Resource external key, and translating
the call's own success/failure into a `DeliveryResult`. It does not decide
which intent to deliver next or when to retry — the Delivery aggregate
does. It does not decide review trust or merge authority — those decisions
already happened before an intent reached delivery.

## Core policies, invariants, and behaviours

- Translating an intent whose Resource is not a GitHub resource (its
  external key's adapter is not `github`) MUST be rejected.
- A pull-request-shaped Resource MUST address the GitHub API by pull
  number; any other Resource MUST address it by issue number, both parsed
  from the Resource's own external key.
- The delivered action MUST derive from the intent's own kind:
  `pr.approve` → an approving review, `pr.merge` → a merge, `status.publish`
  and `reply.publish` → an issue comment. There is no GitHub action for any
  other delivery intent kind.
- Every delivered review or comment body MUST carry the idempotency marker
  for its own intent's event id. A status or reply comment's body MUST be
  the intent's own body text followed by the marker; an approval's review
  body MUST be the marker alone — a `pr.approve` intent's own optional
  `body` is not currently included in the delivered review.
- An approval MUST fail before calling GitHub when the intent has no pull
  number to address; likewise a merge.
- A successful GitHub call MUST report `DeliveryResultKind.Confirmed` with
  the provider's own returned id (the review id for an approval, the merge
  commit sha for a merge, the comment id for a comment). A GitHub call that
  throws MUST report `DeliveryResultKind.Failed` with a fixed adapter error
  code and the underlying error's own message.
- `reconcile` MUST always report `DeliveryResultKind.Unknown`; this
  component does not currently query GitHub to resolve an ambiguous or
  interrupted delivery.

## Dependencies and system role

- Delivery aggregate (depends on this component) — calls `deliver` and
  `reconcile` for any intent whose Resource is a GitHub resource.
- Resources (this component depends on it) — reads the Resource's own
  `externalKey` to address the GitHub API; a Resource that cannot be found
  fails delivery before this component's own translation runs.

## Decisions, exclusions, and deferred capability

- `reconcile` always reporting `unknown` means a GitHub delivery that
  becomes ambiguous, or is interrupted after `delivery.attempt-started`
  without a terminal fact, cannot resolve automatically: the Delivery
  aggregate's reconcile-before-retry rule keeps recording
  `delivery.reconciled` with result `unknown` on every further cycle
  without ever reaching `not-found` (permitting a fresh attempt) or
  `confirmed`. Recovering such an intent currently requires action outside
  this component.
- GitHub label reconciliation and self-echo detection
  (`reconcileGitHubWakeLabels`, `isGitHubWakeEcho`) are not called from
  this component; there is no GitHub outbound action that writes a label.
  See the module page's decisions for the full statement.
