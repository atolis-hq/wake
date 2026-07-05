import { createLifecycleService } from './lifecycle-service.js';
import { createPolicyEngine } from './policy-engine.js';
import { createProjectionUpdater } from './projection-updater.js';
import type {
  AgentRunner,
  AgentRunResult,
  OutboundSink,
  WorkSource,
  WorkspaceManager,
} from './contracts.js';
import type { Clock } from '../lib/clock.js';
import { acquireFileLock } from '../lib/lock.js';
import { parseRunnerResultSentinel } from '../domain/schema.js';
import type { AgentAction, EventEnvelope, WakeConfig } from '../domain/types.js';
import { createEventEnvelope } from '../lib/event-log.js';

export function createTickRunner(deps: {
  clock: Clock;
  config: WakeConfig;
  stateStore: ReturnType<typeof import('../adapters/fs/state-store.js').createStateStore>;
  workSource: WorkSource;
  outboundSink?: OutboundSink;
  runner: AgentRunner;
  workspaceManager: WorkspaceManager;
}) {
  const policy = createPolicyEngine();
  const lifecycle = createLifecycleService();
  const projectionUpdater = createProjectionUpdater({
    stateStore: deps.stateStore,
  });

  function createPublishIntentEvent(input: {
    projection: import('../domain/types.js').IssueStateRecord;
    runId: string;
    action: AgentAction;
    runnerResult: AgentRunResult;
    sentinel: 'DONE' | 'BLOCKED' | 'FAILED';
    occurredAt: string;
    workspacePath?: string;
  }): EventEnvelope | null {
    if (input.sentinel !== 'DONE' && input.sentinel !== 'BLOCKED') {
      return null;
    }

    return createEventEnvelope({
      eventId: `${input.runId}-publish-intent`,
      workItemKey: input.projection.workItemKey,
      streamScope: 'work-item',
      direction: 'outbound',
      sourceSystem: 'wake',
      sourceEventType: 'wake.publish.intent.requested',
      sourceRefs: {
        repo: input.projection.issue.repo,
        issueNumber: input.projection.issue.number,
        runId: input.runId,
      },
      occurredAt: input.occurredAt,
      ingestedAt: input.occurredAt,
      trigger: 'context-only',
      payload: {
        kind: input.sentinel === 'BLOCKED' ? 'question' : 'status-update',
        body: input.runnerResult.result.replace(/\b(DONE|BLOCKED|FAILED)\b/g, '').trim(),
        action: input.action,
        runId: input.runId,
        ...(input.runnerResult.session_id === undefined
          ? {}
          : { sessionId: input.runnerResult.session_id }),
        model: deps.config.runner.claude.model,
        ...(input.workspacePath === undefined
          ? {}
          : { workspacePath: input.workspacePath }),
      },
      derivedHints: {
        stage: input.projection.wake.stage,
      },
    });
  }

  return {
    async runTick() {
      const lock = await acquireFileLock(deps.stateStore.paths.tickLockFile);
      if (!lock.acquired) {
        return { status: 'locked' as const };
      }

      try {
        const nowIso = deps.clock.now().toISOString();
        const inboundEvents = await deps.workSource.pollEvents();
        if (inboundEvents.length > 0) {
          for (const event of inboundEvents) {
            await deps.stateStore.appendEventEnvelope(event);
          }
          await projectionUpdater.rebuildFromEvents(inboundEvents);
        }

        const projections = await deps.stateStore.listIssueStates();
        const candidate = projections.find((issue) => {
          if (!policy.isEligible(issue, deps.config)) {
            return false;
          }

          const nextAction = policy.chooseAction(issue.wake.stage);
          return nextAction !== null && policy.needsWakeAction(issue);
        });

        if (candidate === undefined) {
          return { status: 'idle' as const };
        }

        const action = policy.chooseAction(candidate.wake.stage);
        if (action === null) {
          return { status: 'idle' as const };
        }

        const runId = `run-${candidate.issue.number}-${deps.clock.now().getTime()}`;
        const runningRecord = {
          schemaVersion: 1 as const,
          runId,
          repo: candidate.issue.repo,
          issueNumber: candidate.issue.number,
          action,
          status: 'running' as const,
          startedAt: nowIso,
        };

        await deps.stateStore.writeRunRecord(runningRecord);
        await deps.stateStore.appendEventEnvelope(
          createEventEnvelope({
            eventId: `${runId}-claimed`,
            workItemKey: candidate.workItemKey,
            streamScope: 'work-item',
            direction: 'internal',
            sourceSystem: 'wake',
            sourceEventType: 'wake.run.claimed',
            sourceRefs: {
              repo: candidate.issue.repo,
              issueNumber: candidate.issue.number,
              runId,
            },
            occurredAt: nowIso,
            ingestedAt: nowIso,
            trigger: 'immediate',
            payload: {
              action,
              priorStage: candidate.wake.stage,
            },
          }),
        );

        const workspacePath =
          action === 'implement'
            ? (
                await deps.workspaceManager.prepareWorkspace({
                  repo: candidate.issue.repo,
                  issueNumber: candidate.issue.number,
                })
              ).workspacePath
            : undefined;

        const recentEvents = await deps.stateStore.listEventEnvelopesForWorkItem(
          candidate.workItemKey,
          6,
        );
        const runnerResult = await deps.runner.run({
          action,
          projection: candidate,
          recentEvents,
          config: deps.config,
          runId,
          ...(workspacePath === undefined ? {} : { workspacePath }),
        });
        const sentinel = parseRunnerResultSentinel(runnerResult.result);
        const nextStage = lifecycle.nextStageFromSentinel(action, sentinel);
        const finishedAt = deps.clock.now().toISOString();

        await deps.stateStore.writeRunRecord({
          ...runningRecord,
          status:
            sentinel === 'DONE'
              ? 'completed'
              : sentinel === 'BLOCKED'
                ? 'blocked'
                : 'failed',
          finishedAt,
          sessionId: runnerResult.session_id,
          sentinel,
          summary: runnerResult.result,
          metadata: runnerResult.metadata,
        });

        const runCompletedEvent = createEventEnvelope({
          eventId: `${runId}-completed`,
          workItemKey: candidate.workItemKey,
          streamScope: 'work-item',
          direction: 'internal',
          sourceSystem: 'wake',
          sourceEventType: 'wake.run.completed',
          sourceRefs: {
            repo: candidate.issue.repo,
            issueNumber: candidate.issue.number,
            runId,
          },
          occurredAt: finishedAt,
          ingestedAt: finishedAt,
          trigger: 'immediate',
          payload: {
            action,
            sentinel,
            nextStage,
            runId,
            sessionId: runnerResult.session_id,
            workspacePath,
            reason: `runner:${sentinel.toLowerCase()}`,
            handledCommentId: candidate.latestComment?.isWakeAuthored
              ? undefined
              : candidate.latestComment?.id,
            handledIssueUpdatedAt: candidate.issue.updatedAt,
          },
        });
        await deps.stateStore.appendEventEnvelope(runCompletedEvent);
        await projectionUpdater.rebuildFromEvents([runCompletedEvent]);

        const publishIntent = createPublishIntentEvent({
          projection: candidate,
          runId,
          action,
          runnerResult,
          sentinel,
          occurredAt: finishedAt,
          ...(workspacePath === undefined ? {} : { workspacePath }),
        });

        if (publishIntent !== null) {
          await deps.stateStore.appendEventEnvelope(publishIntent);
          await projectionUpdater.rebuildFromEvents([publishIntent]);

          if (deps.outboundSink !== undefined) {
            const deliveryEvents = await deps.outboundSink.deliverIntent({
              event: publishIntent,
            });
            for (const event of deliveryEvents) {
              await deps.stateStore.appendEventEnvelope(event);
            }
            await projectionUpdater.rebuildFromEvents(deliveryEvents);
          }
        }

        return {
          status: 'processed' as const,
          runId,
          sentinel,
          nextStage,
        };
      } finally {
        await lock.release();
      }
    },
  };
}
