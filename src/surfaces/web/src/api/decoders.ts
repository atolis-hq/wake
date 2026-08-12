import type {
  AuditEventResponse,
  BoardCardResponse,
  CollectionResponse,
  ControlPlaneStatusResponse,
  ResourceItemResponse,
  ResourceResponse,
  RunnerResponse,
  RunResponse,
  RunTranscriptResponse,
  WorkDetailResponse,
  WorkflowInstanceResponse,
  WorkItemResponse,
} from '../../../api/contracts/index.js';
import {
  type AcceptedCommandResponse,
  type TickCommandResponse,
} from '../../../api/contracts/index.js';
import {
  AcceptedCommandStatusValue,
  ResourceItemField,
  RunResponseField,
} from '../../../api/contracts/transport-values.js';
import {
  array,
  boolean,
  child,
  decodeMeta,
  invalid,
  json,
  nullableString,
  number,
  object,
  optionalBooleanProperty,
  optionalNumberProperty,
  optionalStringProperty,
  string,
  type Decoder,
} from './decoder-primitives.js';

export type { Decoder } from './decoder-primitives.js';

const boardCardFieldShape = { stage: true };
const boardStageField = Object.keys(boardCardFieldShape)[0]!;

export function resourceDecoder<Value>(decode: Decoder<Value>): Decoder<ResourceResponse<Value>> {
  return (value, path = '') => {
    const record = object(value, path);
    return {
      data: decode(record.data, child(path, 'data')),
      meta: decodeMeta(record.meta, child(path, 'meta')),
    };
  };
}

export function collectionDecoder<Value>(
  decode: Decoder<Value>,
): Decoder<CollectionResponse<Value>> {
  return (value, path = '') => {
    const record = object(value, path);
    const page = object(record.page, child(path, 'page'));
    return {
      items: array(record.items, child(path, 'items'), decode),
      page: {
        nextCursor: nullableString(page.nextCursor, child(path, 'page.nextCursor')),
        hasMore: boolean(page.hasMore, child(path, 'page.hasMore')),
        ...optionalNumberProperty(page, 'total', child(path, 'page')),
      },
      meta: decodeMeta(record.meta, child(path, 'meta')),
    };
  };
}

export const decodeControlPlaneStatus: Decoder<ControlPlaneStatusResponse> = (value, path = '') => {
  const record = object(value, path);
  return {
    paused: boolean(record.paused, child(path, 'paused')),
    ...optionalStringProperty(record, 'pausedUntil', path),
    ...optionalStringProperty(record, 'reason', path),
    updatedAt: string(record.updatedAt, child(path, 'updatedAt')),
  };
};

export const decodeAcceptedCommand: Decoder<AcceptedCommandResponse> = (value, path = '') => {
  const record = object(value, path);
  const status = string(record.status, child(path, 'status'));
  if (
    status !== AcceptedCommandStatusValue.Accepted &&
    status !== AcceptedCommandStatusValue.Completed
  )
    invalid(child(path, 'status'));
  return {
    commandId: string(record.commandId, child(path, 'commandId')),
    idempotencyKey: string(record.idempotencyKey, child(path, 'idempotencyKey')),
    acceptedAt: string(record.acceptedAt, child(path, 'acceptedAt')),
    status,
  };
};

export const decodeTickCommand: Decoder<TickCommandResponse> = (value, path = '') => {
  const record = object(value, path);
  return {
    ...decodeAcceptedCommand(value, path),
    result: resourceDecoder(decodeControlPlaneStatus)(record.result, child(path, 'result')),
  };
};

export const decodeWorkItem: Decoder<WorkItemResponse> = (value, path = '') => {
  const record = object(value, path);
  return {
    workItemKey: string(record.workItemKey, child(path, 'workItemKey')),
    workItemId: string(record.workItemId, child(path, 'workItemId')),
    objective: string(record.objective, child(path, 'objective')),
    state: string(record.state, child(path, 'state')),
    ...optionalBooleanProperty(record, 'frozen', path),
    ...optionalBooleanProperty(record, 'deleted', path),
    ...optionalStringProperty(record, 'externalRef', path),
    relatedWorkItems: array(
      record.relatedWorkItems,
      child(path, 'relatedWorkItems'),
      (item, itemPath = '') => {
        const related = object(item, itemPath);
        return {
          workItemKey: string(related.workItemKey, child(itemPath ?? '', 'workItemKey')),
          relation: string(related.relation, child(itemPath ?? '', 'relation')),
        };
      },
    ),
  };
};

export const decodeBoardCard: Decoder<BoardCardResponse> = (value, path = '') => {
  const record = object(value, path);
  return {
    workItemKey: string(record.workItemKey, child(path, 'workItemKey')),
    workItemId: string(record.workItemId, child(path, 'workItemId')),
    objective: string(record.objective, child(path, 'objective')),
    condition: string(record.condition, child(path, 'condition')) as BoardCardResponse['condition'],
    ...optionalBooleanProperty(record, 'frozen', path),
    ...optionalBooleanProperty(record, 'awaitingApproval', path),
    ...optionalStringProperty(record, 'workflowName', path),
    ...optionalStringProperty(record, boardStageField, path),
    dwellSince: string(record.dwellSince, child(path, 'dwellSince')),
    runCount: number(record.runCount, child(path, 'runCount')),
    ...optionalStringProperty(record, 'lastRunAt', path),
    ...optionalStringProperty(record, 'lastRunOutcome', path),
    ...optionalNumberProperty(record, 'lastRunAgeMs', path),
    totalTokens: number(record.totalTokens, child(path, 'totalTokens')),
    totalCostUsd: number(record.totalCostUsd, child(path, 'totalCostUsd')),
    totalDurationMs: number(record.totalDurationMs, child(path, 'totalDurationMs')),
    ...(record.activeRun === undefined
      ? {}
      : { activeRun: decodeBoardCardActiveRun(record.activeRun, child(path, 'activeRun')) }),
    ...optionalStringProperty(record, 'externalRef', path),
  };
};

function decodeBoardCardActiveRun(
  value: unknown,
  path: string,
): NonNullable<BoardCardResponse['activeRun']> {
  const record = object(value, path);
  return {
    action: string(record.action, child(path, 'action')),
    startedAt: string(record.startedAt, child(path, 'startedAt')),
    elapsedMs: number(record.elapsedMs, child(path, 'elapsedMs')),
    ...optionalStringProperty(record, 'runnerName', path),
  };
}

export const decodeResourceItem: Decoder<ResourceItemResponse> = (value, path = '') => {
  const record = object(value, path);
  return {
    resourceId: string(record.resourceId, child(path, 'resourceId')),
    adapter: string(record[ResourceItemField.Adapter], child(path, ResourceItemField.Adapter)),
    kind: string(record.kind, child(path, 'kind')),
    locatorLabel: string(record.locatorLabel, child(path, 'locatorLabel')),
    capabilities: array(record.capabilities, child(path, 'capabilities'), string),
    ...optionalStringProperty(record, 'title', path),
    ...optionalStringProperty(record, 'externalUrl', path),
    ...optionalStringProperty(record, 'revision', path),
  };
};

export const decodeWorkflow: Decoder<WorkflowInstanceResponse> = (value, path = '') => {
  const record = object(value, path);
  const waiting = record.waitingFor;
  return {
    workflowInstanceId: string(record.workflowInstanceId, child(path, 'workflowInstanceId')),
    workItemKey: string(record.workItemKey, child(path, 'workItemKey')),
    workflowName: string(record.workflowName, child(path, 'workflowName')),
    orchestrationGroupId: string(record.orchestrationGroupId, child(path, 'orchestrationGroupId')),
    ...optionalStringProperty(record, 'parentWorkflowInstanceId', path),
    status: string(record.status, child(path, 'status')),
    currentStage: string(record.currentStage, child(path, 'currentStage')),
    ...optionalBooleanProperty(record, 'retryEligible', path),
    ...(waiting === undefined
      ? {}
      : {
          waitingFor: {
            signalKind: string(
              object(waiting, child(path, 'waitingFor')).signalKind,
              child(path, 'waitingFor.signalKind'),
            ),
          },
        }),
  };
};

export const decodeRun: Decoder<RunResponse> = (value, path = '') => {
  const record = object(value, path);
  const failure = record.failure;
  return {
    runId: string(record.runId, child(path, 'runId')),
    activationId: string(record.activationId, child(path, 'activationId')),
    activity: string(record.activity, child(path, 'activity')),
    workflowInstanceId: string(record.workflowInstanceId, child(path, 'workflowInstanceId')),
    orchestrationGroupId: string(record.orchestrationGroupId, child(path, 'orchestrationGroupId')),
    attempt: number(record.attempt, child(path, 'attempt')),
    status: string(record.status, child(path, 'status')),
    active: boolean(record.active, child(path, RunResponseField.Active)),
    startedAt: string(record.startedAt, child(path, 'startedAt')),
    ...optionalStringProperty(record, 'finishedAt', path),
    sentinel: string(record.sentinel, child(path, 'sentinel')),
    ...optionalStringProperty(record, 'runnerName', path),
    ...optionalStringProperty(record, 'runnerModel', path),
    ...optionalStringProperty(record, 'workflowName', path),
    ...optionalStringProperty(record, boardStageField, path),
    totalTokens: number(record.totalTokens, child(path, 'totalTokens')),
    totalCostUsd: number(record.totalCostUsd, child(path, 'totalCostUsd')),
    ...(record.outcome === undefined
      ? {}
      : { outcome: json(record.outcome, child(path, 'outcome')) }),
    ...(failure === undefined
      ? {}
      : {
          failure: {
            kind: string(object(failure, child(path, 'failure')).kind, child(path, 'failure.kind')),
          },
        }),
  };
};

export const decodeWorkDetail: Decoder<WorkDetailResponse> = (value, path = '') => {
  const record = object(value, path);
  const orchestration = object(record.orchestration, child(path, 'orchestration'));
  const execution = object(record.execution, child(path, 'execution'));
  const activities = object(record.activities, child(path, 'activities'));
  return {
    work: decodeWorkItem(record.work, child(path, 'work')),
    resources: array(record.resources, child(path, 'resources'), decodeResourceItem),
    orchestration: {
      primary:
        orchestration.primary === null
          ? null
          : decodeWorkflow(orchestration.primary, child(path, 'orchestration.primary')),
      children: array(
        orchestration.children,
        child(path, 'orchestration.children'),
        decodeWorkflow,
      ),
    },
    execution: {
      runs: array(execution.runs, child(path, 'execution.runs'), decodeRun),
      transcriptGroups: array(
        execution.transcriptGroups,
        child(path, 'execution.transcriptGroups'),
        (item, itemPath = '') => {
          const group = object(item, itemPath);
          return {
            groupId: string(group.groupId, child(itemPath, 'groupId')),
            kind: transcriptGroupKind(group.kind, child(itemPath, 'kind')),
            ...optionalStringProperty(group, 'cli', itemPath),
            latestAt: string(group.latestAt, child(itemPath, 'latestAt')),
            runIds: array(group.runIds, child(itemPath, 'runIds'), string),
          };
        },
      ),
    },
    activities:
      activities.pullRequest === undefined
        ? {}
        : {
            pullRequest: decodePullRequest(
              activities.pullRequest,
              child(path, 'activities.pullRequest'),
            ),
          },
  };
};

export const decodeAuditEvent: Decoder<AuditEventResponse> = (value, path = '') => {
  const record = object(value, path);
  const stream = record.stream;
  return {
    id: string(record.id, child(path, 'id')),
    type: string(record.type, child(path, 'type')),
    occurredAt: string(record.occurredAt, child(path, 'occurredAt')),
    position: number(record.position, child(path, 'position')),
    ...(stream === undefined
      ? {}
      : {
          stream: {
            kind: string(object(stream, child(path, 'stream')).kind, child(path, 'stream.kind')),
            id: string(object(stream, child(path, 'stream')).id, child(path, 'stream.id')),
          },
        }),
    ...optionalStringProperty(record, 'causationId', path),
    ...optionalStringProperty(record, 'correlationId', path),
    payload: record.payload,
  };
};

export const decodeRunner: Decoder<RunnerResponse> = (value, path = '') => {
  const record = object(value, path);
  return {
    runnerId: string(record.runnerId, child(path, 'runnerId')),
    status: string(record.status, child(path, 'status')),
    available: boolean(record.available, child(path, 'available')),
    ...optionalStringProperty(record, 'detail', path),
    updatedAt: string(record.updatedAt, child(path, 'updatedAt')),
  };
};

export const decodeTranscript: Decoder<RunTranscriptResponse> = (value, path = '') => {
  const record = object(value, path);
  return {
    runId: string(record.runId, child(path, 'runId')),
    ...optionalStringProperty(record, 'groupId', path),
    available: boolean(record.available, child(path, 'available')),
    entries: array(record.entries, child(path, 'entries'), (item, itemPath = '') => {
      const entry = object(item, itemPath);
      return {
        occurredAt: string(entry.occurredAt, child(itemPath, 'occurredAt')),
        channel: transcriptChannel(entry.channel, child(itemPath, 'channel')),
        text: string(entry.text, child(itemPath, 'text')),
        runId: string(entry.runId, child(itemPath, 'runId')),
        groupId: string(entry.groupId, child(itemPath, 'groupId')),
        ...optionalNumberProperty(entry, 'durationMs', itemPath),
      };
    }),
  };
};

function transcriptChannel(value: unknown, path: string): 'input' | 'agent' {
  const channel = string(value, path);
  if (channel !== 'input' && channel !== 'agent') invalid(path);
  return channel;
}

function transcriptGroupKind(value: unknown, path: string): 'session' | 'run' {
  const kind = string(value, path);
  if (kind !== 'session' && kind !== 'run') invalid(path);
  return kind;
}

function decodePullRequest(value: unknown, path = '') {
  const record = object(value, path);
  return {
    resourceId: string(record.resourceId, child(path, 'resourceId')),
    state: string(record.state, child(path, 'state')),
    ...optionalBooleanProperty(record, 'frozen', path),
    ...optionalBooleanProperty(record, 'deleted', path),
    headRevision: string(record.headRevision, child(path, 'headRevision')),
    baseRevision: string(record.baseRevision, child(path, 'baseRevision')),
    checks: string(record.checks, child(path, 'checks')),
  };
}
