import type {
  AuditEventResponse,
  BoardCardActiveRun,
  BoardCardResponse,
  CollectionResponse,
  ControlPlaneStatusResponse,
  ResourceItemResponse,
  ResourceResponse,
  RunnerResponse,
  RunResponse,
  RunTranscriptResponse,
  TranscriptEntryResponse,
  TranscriptGroupResponse,
  WorkDetailResponse,
  WorkflowDiagramResponse,
  WorkflowDiagramsResponse,
  WorkflowInstanceResponse,
  WorkItemResponse,
  WorkItemTranscriptResponse,
} from '../../../api/contracts/index.js';
import {
  WorkflowDiagramChildKind,
  type AcceptedCommandResponse,
  type TickCommandResponse,
} from '../../../api/contracts/index.js';
import {
  AcceptedCommandStatusValue,
  ResourceItemField,
  RunResponseField,
  TranscriptChannelValue,
  TranscriptGroupKindValue,
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
    ...(record.maintenanceLease === undefined
      ? {}
      : {
          maintenanceLease: decodeControlPlaneMaintenanceLease(
            record.maintenanceLease,
            child(path, 'maintenanceLease'),
          ),
        }),
  };
};

function decodeControlPlaneMaintenanceLease(
  value: unknown,
  path: string,
): NonNullable<ControlPlaneStatusResponse['maintenanceLease']> {
  const record = object(value, path);
  return {
    phase: string(record.phase, child(path, 'phase')),
    startedAt: string(record.startedAt, child(path, 'startedAt')),
    ...optionalStringProperty(record, 'failure', path),
  };
}

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
    ...optionalStringProperty(record, 'lastRunOutcome', path),
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
    ...optionalStringProperty(record, 'blockReason', path),
    dwellSince: string(record.dwellSince, child(path, 'dwellSince')),
    runCount: number(record.runCount, child(path, 'runCount')),
    ...optionalStringProperty(record, 'lastRunAt', path),
    ...optionalStringProperty(record, 'lastRunOutcome', path),
    ...optionalNumberProperty(record, 'lastRunAgeMs', path),
    totalTokens: number(record.totalTokens, child(path, 'totalTokens')),
    ...optionalNumberProperty(record, 'inputTokens', path),
    ...optionalNumberProperty(record, 'outputTokens', path),
    ...optionalNumberProperty(record, 'cacheReadTokens', path),
    ...optionalNumberProperty(record, 'cacheWriteTokens', path),
    totalCostUsd: number(record.totalCostUsd, child(path, 'totalCostUsd')),
    totalDurationMs: number(record.totalDurationMs, child(path, 'totalDurationMs')),
    activeRuns: decodeBoardCardActiveRuns(record.activeRuns, child(path, 'activeRuns')),
    ...optionalStringProperty(record, 'externalRef', path),
  };
};

function decodeBoardCardActiveRuns(
  value: unknown,
  path: string,
): NonNullable<BoardCardResponse['activeRuns']> {
  if (value === undefined) return {};
  return Object.fromEntries(
    Object.entries(object(value, path)).map(([runId, activeRun]) => [
      runId,
      decodeBoardCardActiveRun(activeRun, child(path, runId)),
    ]),
  );
}

function decodeBoardCardActiveRun(value: unknown, path: string): BoardCardActiveRun {
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
    ...optionalStringProperty(record, 'blockReason', path),
    ...optionalBooleanProperty(record, 'retryEligible', path),
    ...optionalBooleanProperty(record, 'extendEligible', path),
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

export const decodeWorkflowDiagrams: Decoder<WorkflowDiagramsResponse> = (value, path = '') => {
  const record = object(value, path);
  return { diagrams: array(record.diagrams, child(path, 'diagrams'), decodeWorkflowDiagram) };
};

function decodeWorkflowDiagram(value: unknown, path = ''): WorkflowDiagramResponse {
  const record = object(value, path);
  return {
    id: string(record.id, child(path, 'id')),
    label: string(record.label, child(path, 'label')),
    direction: 'left-to-right',
    stages: array(record.stages, child(path, 'stages'), (stage, stagePath = '') => {
      const item = object(stage, stagePath);
      return {
        id: string(item.id, child(stagePath, 'id')),
        label: string(item.label, child(stagePath, 'label')),
        children: array(item.children, child(stagePath, 'children'), (card, cardPath = '') => {
          const childCard = object(card, cardPath);
          return {
            id: string(childCard.id, child(cardPath, 'id')),
            label: string(childCard.label, child(cardPath, 'label')),
            kind: workflowDiagramChildKind(childCard.kind, child(cardPath, 'kind')),
            ...diagramOverlayFields(childCard, cardPath),
          };
        }),
        ...diagramOverlayFields(item, stagePath),
      };
    }),
    transitions: array(
      record.transitions,
      child(path, 'transitions'),
      (transition, transitionPath = '') => {
        const item = object(transition, transitionPath);
        return {
          from: string(item.from, child(transitionPath, 'from')),
          to: string(item.to, child(transitionPath, 'to')),
          label: string(item.label, child(transitionPath, 'label')),
          ...optionalStringProperty(item, 'fromChildId', transitionPath),
        };
      },
    ),
  };
}

function workflowDiagramChildKind(value: unknown, path: string) {
  const kind = string(value, path);
  if (!Object.values(WorkflowDiagramChildKind).includes(kind as WorkflowDiagramChildKind))
    invalid(path);
  return kind as WorkflowDiagramChildKind;
}

function diagramOverlayFields(record: Record<string, unknown>, path: string) {
  const activeRuns = record.activeRuns;
  return {
    ...optionalStringProperty(record, 'status', path),
    ...optionalStringProperty(record, 'lastOutcome', path),
    ...optionalNumberProperty(record, 'runCount', path),
    ...optionalNumberProperty(record, 'totalDurationMs', path),
    ...optionalNumberProperty(record, 'totalTokens', path),
    ...optionalNumberProperty(record, 'inputTokens', path),
    ...optionalNumberProperty(record, 'outputTokens', path),
    ...optionalNumberProperty(record, 'cacheReadTokens', path),
    ...optionalNumberProperty(record, 'cacheWriteTokens', path),
    ...optionalNumberProperty(record, 'totalCostUsd', path),
    ...(activeRuns === undefined
      ? {}
      : {
          activeRuns: array(activeRuns, child(path, 'activeRuns'), (run, runPath = '') => {
            const item = object(run, runPath);
            return {
              runId: string(item.runId, child(runPath, 'runId')),
              activity: string(item.activity, child(runPath, 'activity')),
              startedAt: string(item.startedAt, child(runPath, 'startedAt')),
              ...optionalStringProperty(item, 'runnerName', runPath),
            };
          }),
        }),
  };
}

const runResolutionSentinels = ['DONE', 'FAILED', 'AMBIGUOUS'] as const;

function decodeRunResolution(
  value: unknown,
  parentPath: string,
): NonNullable<RunResponse['resolution']> {
  const path = child(parentPath, 'resolution');
  const record = object(value, path);
  const sentinel = string(record.sentinel, child(path, 'sentinel'));
  if (!runResolutionSentinels.includes(sentinel as (typeof runResolutionSentinels)[number]))
    invalid(child(path, 'sentinel'));
  return {
    sentinel: sentinel as (typeof runResolutionSentinels)[number],
    resolvedAt: string(record.resolvedAt, child(path, 'resolvedAt')),
  };
}

export const decodeRun: Decoder<RunResponse> = (value, path = '') => {
  const record = object(value, path);
  const failure = record.failure;
  const resolution = record.resolution;
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
    ...optionalNumberProperty(record, 'inputTokens', path),
    ...optionalNumberProperty(record, 'outputTokens', path),
    ...optionalNumberProperty(record, 'cacheReadTokens', path),
    ...optionalNumberProperty(record, 'cacheWriteTokens', path),
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
    ...(resolution === undefined ? {} : { resolution: decodeRunResolution(resolution, path) }),
  };
};

export const decodeWorkDetail: Decoder<WorkDetailResponse> = (value, path = '') => {
  const conversationTransportField = Object.keys({ conversation: true })[0]!;
  const conversationEntryStageField = Object.keys({ stage: true })[0]!;
  const record = object(value, path);
  const orchestration = object(record.orchestration, child(path, 'orchestration'));
  const execution = object(record.execution, child(path, 'execution'));
  const activities = object(record.activities, child(path, 'activities'));
  const conversation =
    record.conversation === undefined
      ? undefined
      : object(record.conversation, child(path, conversationTransportField));
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
      diagram: decodeWorkflowDiagramLink(
        orchestration.diagram,
        child(path, 'orchestration.diagram'),
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
    conversation: {
      entries:
        conversation === undefined
          ? []
          : array(
              conversation.entries,
              child(path, `${conversationTransportField}.entries`),
              (item, itemPath = '') => {
                const entry = object(item, itemPath);
                return {
                  entryId: string(entry.entryId, child(itemPath, 'entryId')),
                  body: string(entry.body, child(itemPath, 'body')),
                  occurredAt: string(entry.occurredAt, child(itemPath, 'occurredAt')),
                  origin: string(entry.origin, child(itemPath, 'origin')),
                  actorId: string(entry.actorId, child(itemPath, 'actorId')),
                  ...optionalStringProperty(entry, 'runId', itemPath),
                  ...optionalStringProperty(entry, conversationEntryStageField, itemPath),
                  ...optionalStringProperty(entry, 'sourceResourceId', itemPath),
                  ...optionalStringProperty(entry, 'sourceThreadId', itemPath),
                  deleted: boolean(entry.deleted, child(itemPath, 'deleted')),
                  representations: array(
                    entry.representations,
                    child(itemPath, 'representations'),
                    (representation, representationPath = '') => {
                      const value = object(representation, representationPath);
                      return {
                        resourceId: string(
                          value.resourceId,
                          child(representationPath, 'resourceId'),
                        ),
                        externalId: string(
                          value.externalId,
                          child(representationPath, 'externalId'),
                        ),
                      };
                    },
                  ),
                };
              },
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

export const decodeWorkTranscript: Decoder<WorkItemTranscriptResponse> = (value, path = '') => {
  const record = object(value, path);
  return {
    groupId: string(record.groupId, child(path, 'groupId')),
    available: boolean(record.available, child(path, 'available')),
    entries: array(record.entries, child(path, 'entries'), decodeTranscriptEntry),
  };
};

function decodeTranscriptEntry(item: unknown, itemPath = '') {
  const entry = object(item, itemPath);
  return {
    occurredAt: string(entry.occurredAt, child(itemPath, 'occurredAt')),
    channel: transcriptChannel(entry.channel, child(itemPath, 'channel')),
    text: string(entry.text, child(itemPath, 'text')),
    runId: string(entry.runId, child(itemPath, 'runId')),
    groupId: string(entry.groupId, child(itemPath, 'groupId')),
    ...optionalNumberProperty(entry, 'durationMs', itemPath),
  };
}

function decodeWorkflowDiagramLink(value: unknown, path: string) {
  const record = object(value, path);
  return { href: string(record.href, child(path, 'href')) };
}

function transcriptChannel(value: unknown, path: string): TranscriptEntryResponse['channel'] {
  const channel = string(value, path);
  if (channel !== TranscriptChannelValue.Input && channel !== TranscriptChannelValue.Agent)
    invalid(path);
  return channel;
}

function transcriptGroupKind(value: unknown, path: string): TranscriptGroupResponse['kind'] {
  const kind = string(value, path);
  if (kind !== TranscriptGroupKindValue.Session && kind !== TranscriptGroupKindValue.Run)
    invalid(path);
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
