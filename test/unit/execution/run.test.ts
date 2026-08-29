import { expect, it } from 'vitest';
import { activationId, activityName } from '../../../src/activities/index.js';
import {
  ExecutionEventType,
  ExecutionFailureCode,
  foldRun,
  isActiveRunStatus,
  runId,
  RunStatus,
  runStream,
  WorkspaceMode,
} from '../../../src/execution/index.js';
import { orchestrationGroupId, workflowInstanceId } from '../../../src/orchestration/index.js';
import { eventEnvelope } from '../../support/event-envelope.js';

it('keeps transport status separate from the Activity outcome', () => {
  expect(foldRun([])).toBeNull();
});

it('projects the originating stage from the run start event', () => {
  const started = eventEnvelope(
    ExecutionEventType.RunStarted,
    {
      activationId: activationId('activation-1'),
      activity: activityName('implement'),
      stage: 'refine',
      workflowInstanceId: workflowInstanceId('workflow-1'),
      orchestrationGroupId: orchestrationGroupId('group-1'),
      attempt: 1,
      startedAt: '2026-07-31T12:00:00.000Z',
    },
    runStream(runId('run-1')),
  );

  expect(foldRun([started])).toMatchObject({ stage: 'refine' });
});

it('rejects a run start that contradicts preparation identity or runner', () => {
  const stream = runStream(runId('run-1'));
  const preparation = eventEnvelope(
    ExecutionEventType.RunPreparationStarted,
    {
      activationId: activationId('activation-1'),
      activity: activityName('implement'),
      stage: 'refine',
      workflowInstanceId: workflowInstanceId('workflow-1'),
      orchestrationGroupId: orchestrationGroupId('group-1'),
      attempt: 1,
      startedAt: '2026-07-31T11:59:00.000Z',
      runner: { name: 'codex', model: 'gpt-5.1' },
    },
    stream,
  );
  const started = eventEnvelope(
    ExecutionEventType.RunStarted,
    {
      activationId: activationId('other-activation'),
      activity: activityName('other-activity'),
      workflowInstanceId: workflowInstanceId('other-workflow'),
      orchestrationGroupId: orchestrationGroupId('other-group'),
      attempt: 2,
      startedAt: '2026-07-31T12:00:00.000Z',
      runner: { name: 'other-runner' },
      workspace: { mode: WorkspaceMode.Branch, path: 'C:\\repo', branch: 'wake/work-1' },
    },
    stream,
  );
  const failed = eventEnvelope(
    ExecutionEventType.RunFailed,
    {
      failure: {
        kind: ExecutionFailureCode.Unexpected,
        message: 'workspace preparation failed',
      },
      finishedAt: '2026-07-31T12:01:00.000Z',
    },
    stream,
  );

  expect(foldRun([preparation])).toMatchObject({
    status: RunStatus.Starting,
    startedAt: '2026-07-31T11:59:00.000Z',
    runner: { name: 'codex', model: 'gpt-5.1' },
  });
  expect(() => foldRun([preparation, started, failed])).toThrow(
    /Invalid Run stream.*activationId/i,
  );
});

it('folds a run start that matches preparation identity and runner', () => {
  const stream = runStream(runId('run-1'));
  const preparation = eventEnvelope(
    ExecutionEventType.RunPreparationStarted,
    {
      activationId: activationId('activation-1'),
      activity: activityName('implement'),
      stage: 'refine',
      workflowInstanceId: workflowInstanceId('workflow-1'),
      orchestrationGroupId: orchestrationGroupId('group-1'),
      attempt: 1,
      startedAt: '2026-07-31T11:59:00.000Z',
      runner: { name: 'codex', model: 'gpt-5.1', effort: 'high', pool: 'default', cli: 'codex' },
    },
    stream,
  );
  const started = eventEnvelope(
    ExecutionEventType.RunStarted,
    {
      activationId: activationId('activation-1'),
      activity: activityName('implement'),
      stage: 'refine',
      workflowInstanceId: workflowInstanceId('workflow-1'),
      orchestrationGroupId: orchestrationGroupId('group-1'),
      attempt: 1,
      startedAt: '2026-07-31T12:00:00.000Z',
      runner: { name: 'codex', model: 'gpt-5.1', effort: 'high', pool: 'default', cli: 'codex' },
      workspace: { mode: WorkspaceMode.Branch, path: 'C:\\repo', branch: 'wake/work-1' },
    },
    stream,
  );

  expect(foldRun([preparation, started])).toMatchObject({
    activationId: activationId('activation-1'),
    activity: activityName('implement'),
    workflowInstanceId: workflowInstanceId('workflow-1'),
    orchestrationGroupId: orchestrationGroupId('group-1'),
    attempt: 1,
    status: RunStatus.Started,
    startedAt: '2026-07-31T11:59:00.000Z',
    executionStartedAt: '2026-07-31T12:00:00.000Z',
    runner: { name: 'codex', model: 'gpt-5.1', effort: 'high', pool: 'default', cli: 'codex' },
    workspace: { mode: 'branch', path: 'C:\\repo', branch: 'wake/work-1' },
  });
});

it('sets both start times for historical run-started streams', () => {
  const started = eventEnvelope(
    ExecutionEventType.RunStarted,
    {
      activationId: activationId('activation-1'),
      activity: activityName('implement'),
      workflowInstanceId: workflowInstanceId('workflow-1'),
      orchestrationGroupId: orchestrationGroupId('group-1'),
      attempt: 1,
      startedAt: '2026-07-31T12:00:00.000Z',
    },
    runStream(runId('run-1')),
  );

  expect(foldRun([started])).toMatchObject({
    status: RunStatus.Started,
    startedAt: '2026-07-31T12:00:00.000Z',
    executionStartedAt: '2026-07-31T12:00:00.000Z',
  });
});

it('folds a failure directly after preparation', () => {
  const stream = runStream(runId('run-1'));
  const preparation = eventEnvelope(
    ExecutionEventType.RunPreparationStarted,
    {
      activationId: activationId('activation-1'),
      activity: activityName('implement'),
      workflowInstanceId: workflowInstanceId('workflow-1'),
      orchestrationGroupId: orchestrationGroupId('group-1'),
      attempt: 1,
      startedAt: '2026-07-31T11:59:00.000Z',
    },
    stream,
  );
  const failed = eventEnvelope(
    ExecutionEventType.RunFailed,
    {
      failure: {
        kind: ExecutionFailureCode.Unexpected,
        message: 'workspace preparation failed',
      },
      finishedAt: '2026-07-31T12:00:00.000Z',
    },
    stream,
  );

  expect(foldRun([preparation, failed])).toMatchObject({
    status: RunStatus.Failed,
    startedAt: '2026-07-31T11:59:00.000Z',
    finishedAt: '2026-07-31T12:00:00.000Z',
  });
});

it('rejects a preparation event that occurs after another run event', () => {
  const stream = runStream(runId('run-1'));
  const preparation = eventEnvelope(
    ExecutionEventType.RunPreparationStarted,
    {
      activationId: activationId('activation-1'),
      activity: activityName('implement'),
      workflowInstanceId: workflowInstanceId('workflow-1'),
      orchestrationGroupId: orchestrationGroupId('group-1'),
      attempt: 1,
      startedAt: '2026-07-31T11:59:00.000Z',
    },
    stream,
  );
  const lease = eventEnvelope(
    ExecutionEventType.RunLeaseClaimed,
    {
      owner: 'resident-a',
      acquiredAt: '2026-07-31T11:58:00.000Z',
      expiresAt: '2026-07-31T12:01:00.000Z',
    },
    stream,
  );
  const started = eventEnvelope(
    ExecutionEventType.RunStarted,
    {
      activationId: activationId('activation-1'),
      activity: activityName('implement'),
      workflowInstanceId: workflowInstanceId('workflow-1'),
      orchestrationGroupId: orchestrationGroupId('group-1'),
      attempt: 1,
      startedAt: '2026-07-31T12:00:00.000Z',
    },
    stream,
  );

  expect(() => foldRun([lease, preparation])).toThrow(/Invalid Run stream.*first/i);
  expect(() => foldRun([started, preparation])).toThrow(/Invalid Run stream.*preparation/i);
});

it('rejects duplicate run preparation events', () => {
  const stream = runStream(runId('run-1'));
  const preparation = eventEnvelope(
    ExecutionEventType.RunPreparationStarted,
    {
      activationId: activationId('activation-1'),
      activity: activityName('implement'),
      workflowInstanceId: workflowInstanceId('workflow-1'),
      orchestrationGroupId: orchestrationGroupId('group-1'),
      attempt: 1,
      startedAt: '2026-07-31T11:59:00.000Z',
    },
    stream,
  );

  expect(() => foldRun([preparation, preparation])).toThrow(/Invalid Run stream.*preparation/i);
});

it('rejects a duplicate run start after preparation', () => {
  const stream = runStream(runId('run-1'));
  const preparation = eventEnvelope(
    ExecutionEventType.RunPreparationStarted,
    {
      activationId: activationId('activation-1'),
      activity: activityName('implement'),
      workflowInstanceId: workflowInstanceId('workflow-1'),
      orchestrationGroupId: orchestrationGroupId('group-1'),
      attempt: 1,
      startedAt: '2026-07-31T11:59:00.000Z',
    },
    stream,
  );
  const started = eventEnvelope(
    ExecutionEventType.RunStarted,
    {
      activationId: activationId('activation-1'),
      activity: activityName('implement'),
      workflowInstanceId: workflowInstanceId('workflow-1'),
      orchestrationGroupId: orchestrationGroupId('group-1'),
      attempt: 1,
      startedAt: '2026-07-31T12:00:00.000Z',
    },
    stream,
  );
  const duplicate = eventEnvelope(
    ExecutionEventType.RunStarted,
    {
      activationId: activationId('other-activation'),
      activity: activityName('other-activity'),
      workflowInstanceId: workflowInstanceId('other-workflow'),
      orchestrationGroupId: orchestrationGroupId('other-group'),
      attempt: 2,
      startedAt: '2026-07-31T12:01:00.000Z',
      workspace: { mode: WorkspaceMode.Branch, path: 'C:\\other-repo' },
    },
    stream,
  );

  expect(() => foldRun([preparation, started, duplicate])).toThrow(
    /Invalid Run stream.*RunStarted.*starting/i,
  );
});

it('rejects a duplicate run start in a historical stream', () => {
  const stream = runStream(runId('run-1'));
  const started = eventEnvelope(
    ExecutionEventType.RunStarted,
    {
      activationId: activationId('activation-1'),
      activity: activityName('implement'),
      workflowInstanceId: workflowInstanceId('workflow-1'),
      orchestrationGroupId: orchestrationGroupId('group-1'),
      attempt: 1,
      startedAt: '2026-07-31T12:00:00.000Z',
    },
    stream,
  );
  const duplicate = eventEnvelope(
    ExecutionEventType.RunStarted,
    {
      activationId: activationId('activation-1'),
      activity: activityName('implement'),
      workflowInstanceId: workflowInstanceId('workflow-1'),
      orchestrationGroupId: orchestrationGroupId('group-1'),
      attempt: 1,
      startedAt: '2026-07-31T12:01:00.000Z',
    },
    stream,
  );

  expect(() => foldRun([started, duplicate])).toThrow(/Invalid Run stream.*RunStarted.*starting/i);
});

it('identifies starting and started runs as active', () => {
  expect(RunStatus.Starting).toBe('starting');
  expect(isActiveRunStatus('starting')).toBe(true);
  expect(isActiveRunStatus(RunStatus.Started)).toBe(true);
  expect(isActiveRunStatus(RunStatus.Failed)).toBe(false);
});
