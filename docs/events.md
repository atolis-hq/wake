# Wake event types

Wake event envelopes store the literal event type in `sourceEventType`. Wake-owned event types use the `wake.<noun>.<verb-or-state>` convention and are defined in `src/domain/event-types.ts`.

External adapters also emit provider event types such as `ticket.*`, `pr.*`, and `fake.*`; those are source-specific vocabularies and are not part of this Wake-owned catalog.

| Event type | Meaning | Payload shape |
| --- | --- | --- |
| `wake.audit.autonomous-decision` | Records an autonomous workflow decision and the inputs used to make it. | `{ decisionType, workItemId, runId, workflowRevision, inputsConsidered, outcome, timestamp }` |
| `wake.correlation.primary-conflict` | Warns that a requested primary resource correlation was downgraded because another work item already owns the resource. | `{ resourceUri, incumbentWorkItemKey }` |
| `wake.correlation.registered` | Registers a resource URI as correlated to a work item. | `{ resourceUri, role, relation, provenance, registeredBy? }` |
| `wake.correlation.retracted` | Removes a resource URI correlation from a work item. | `{ resourceUri }` |
| `wake.labels.requested` | Requests outbound synchronization of Wake status, stage, and workflow labels. | `{ statusLabel, stageLabel, workflowLabel, origin, idempotencyKey, deliveryState: 'PENDING' }` |
| `wake.pr-auto-merge.enabled` | Records that Wake enabled auto-merge for an approved pull request. | `{ idempotencyKey }` |
| `wake.pr-review.approved` | Records that Wake approved a pull request review after approval policy passed. | `{ idempotencyKey }` |
| `wake.publish.confirmed` | Confirms that an outbound publish intent was delivered or intentionally suppressed. | `{ intentEventId, idempotencyKey, deliveryState: 'CONFIRMED', ...sinkDetails }` |
| `wake.publish.failed` | Records a failed outbound publish attempt for bounded retry. | `{ intentEventId, intentEventType, idempotencyKey, deliveryState: 'PENDING', error }` |
| `wake.publish.intent.requested` | Requests an outbound comment, reply, status update, question, or approval card. | `{ kind, origin, body, action, sentinel, runId, idempotencyKey, deliveryState: 'PENDING', sessionId?, model?, cli?, duration?, tokens?, cost?, workspacePath?, failureRepeated?, previousFailureClass? }` |
| `wake.publish.sent-unconfirmed` | Marks an outbound publish intent as sent before Wake has observed confirmation. | `{ intentEventId, intentEventType, idempotencyKey, deliveryState: 'SENT_UNCONFIRMED' }` |
| `wake.retry.requested` | Requests that a failed work item be retried. | `{ requestedBy }` |
| `wake.run.claimed` | Records that Wake claimed a work item for an agent run. | `{ action, priorStage, claimedStage?, sourceRevision, watcherRun?, watcherTrigger? }` |
| `wake.run.completed` | Records the terminal result of an agent run or internal lifecycle transition. | `{ action?, sentinel, nextStage?, runId, sessionId?, sessionCli?, workspacePath?, reason?, handledCommentId?, failureClass?, blockReason?, executionOutcome?, workflowOutcome?, watcherRun?, allowAutoApproval?, body? }` |
| `wake.workflow.selected` | Pins the workflow selected for a newly minted work item. | `{ workflow, selectedFromEventId }` |
| `wake.workitem.created` | Mints a Wake work item identity before resource correlation is registered. | `{}` |
| `wake.workspace.cleaned` | Records successful cleanup of a closed issue workspace. | `{ workspacePath }` |
| `wake.workspace.cleanup-failed` | Records a workspace cleanup failure without aborting the cleanup sweep. | `{ workspacePath, error }` |
