import {
  type AcceptedCommandResponse,
  type AdvanceCommandResponse,
  AuditEventResponse,
  CollectionResponse,
  ControlPlaneStatusResponse,
  ResourceItemResponse,
  ResourceResponse,
  RunnerResponse,
  RunResponse,
  RunTranscriptResponse,
  WorkflowInstanceResponse,
  WorkDetailResponse,
  WorkItemResponse,
} from '../../../api/contracts/index.js';
import {
  AcceptedCommandStatusValue,
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
  optionalNumberProperty,
  optionalStringProperty,
  string,
  type Decoder,
} from './decoder-primitives.js';
export type { Decoder } from './decoder-primitives.js';

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

export const decodeAdvanceCommand: Decoder<AdvanceCommandResponse> = (value, path = '') => {
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

export const decodeResourceItem: Decoder<ResourceItemResponse> = (value, path = '') => {
  const record = object(value, path);
  return {
    resourceId: string(record.resourceId, child(path, 'resourceId')),
    kind: string(record.kind, child(path, 'kind')),
    capabilities: array(record.capabilities, child(path, 'capabilities'), string),
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
    execution: { runs: array(execution.runs, child(path, 'execution.runs'), decodeRun) },
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
    available: boolean(record.available, child(path, 'available')),
    entries: array(record.entries, child(path, 'entries'), (item, itemPath = '') => {
      const entry = object(item, itemPath);
      return {
        occurredAt: string(entry.occurredAt, child(itemPath, 'occurredAt')),
        channel: string(entry.channel, child(itemPath, 'channel')),
        text: string(entry.text, child(itemPath, 'text')),
      };
    }),
  };
};

function decodePullRequest(value: unknown, path = '') {
  const record = object(value, path);
  return {
    resourceId: string(record.resourceId, child(path, 'resourceId')),
    state: string(record.state, child(path, 'state')),
    headRevision: string(record.headRevision, child(path, 'headRevision')),
    baseRevision: string(record.baseRevision, child(path, 'baseRevision')),
    checks: string(record.checks, child(path, 'checks')),
  };
}
