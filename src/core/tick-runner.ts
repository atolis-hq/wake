import { createLifecycleService } from './lifecycle-service.js';
import { createPolicyEngine } from './policy-engine.js';
import type { AgentRunner, WorkSource, WorkspaceManager } from './contracts.js';
import type { Clock } from '../lib/clock.js';
import { acquireFileLock } from '../lib/lock.js';
import { parseRunnerResultSentinel } from '../domain/schema.js';
import type { WakeConfig } from '../domain/types.js';
import { createEventRecord } from '../lib/event-log.js';

export function createTickRunner(deps: {
  clock: Clock;
  config: WakeConfig;
  stateStore: ReturnType<typeof import('../adapters/fs/state-store.js').createStateStore>;
  workSource: WorkSource;
  runner: AgentRunner;
  workspaceManager: WorkspaceManager;
}) {
  const policy = createPolicyEngine();
  const lifecycle = createLifecycleService();

  return {
    async runTick() {
      const lock = await acquireFileLock(deps.stateStore.paths.tickLockFile);
      if (!lock.acquired) {
        return { status: 'locked' as const };
      }

      try {
        const nowIso = deps.clock.now().toISOString();
        const synced = await deps.workSource.syncIssues();

        for (const issue of synced) {
          await deps.stateStore.writeIssueState(issue);
          await deps.stateStore.appendEvent(
            createEventRecord({
              type: 'issue.synced',
              occurredAt: nowIso,
              repo: issue.issue.repo,
              issueNumber: issue.issue.number,
              payload: {
                stage: issue.wake.stage,
                labels: issue.issue.labels,
              },
            }),
          );
        }

        const candidate = synced.find((issue) => {
          const nextAction = policy.chooseAction(issue.wake.stage);
          return nextAction !== null;
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
        await deps.stateStore.appendEvent(
          createEventRecord({
            type: 'run.claimed',
            occurredAt: nowIso,
            repo: candidate.issue.repo,
            issueNumber: candidate.issue.number,
            runId,
            payload: {
              action,
              priorStage: candidate.wake.stage,
            },
          }),
        );

        const { workspacePath } = await deps.workspaceManager.prepareWorkspace({
          repo: candidate.issue.repo,
          issueNumber: candidate.issue.number,
        });

        const runnerResult = await deps.runner.run({
          action,
          issue: candidate,
          config: deps.config,
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

        await deps.stateStore.writeIssueState({
          ...candidate,
          wake: {
            ...candidate.wake,
            stage: nextStage,
            lastRunId: runId,
            sessionId: runnerResult.session_id,
            workspacePath,
            syncedAt: finishedAt,
            stageHistory: [
              ...candidate.wake.stageHistory,
              {
                stage: nextStage,
                changedAt: finishedAt,
                reason: `runner:${sentinel.toLowerCase()}`,
              },
            ],
          },
        });

        await deps.stateStore.appendEvent(
          createEventRecord({
            type: 'run.completed',
            occurredAt: finishedAt,
            repo: candidate.issue.repo,
            issueNumber: candidate.issue.number,
            runId,
            payload: {
              action,
              sentinel,
              nextStage,
              sessionId: runnerResult.session_id,
            },
          }),
        );

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
