import type { ResourceItemResponse } from '../../../api/contracts/resources.js';
import type {
  DeliveryIntegrationResponse,
  WorkDetailResponse,
} from '../../../api/contracts/work.js';
import type { Decoder } from './decoder-primitives.js';
import {
  array,
  boolean,
  child,
  number,
  object,
  optionalStringProperty,
  string,
} from './decoder-primitives.js';

const integrationFields = { complete: true, maintenance: true, integration: true };
const [completeField, maintenanceField, integrationField] = Object.keys(integrationFields);

export function decodeDelivery(
  value: unknown,
  path: string,
  decodeResourceItem: Decoder<ResourceItemResponse>,
): WorkDetailResponse['delegation'] {
  if (value === undefined) return undefined;
  const record = object(value, path);
  return {
    rootWorkItemKey: string(record.rootWorkItemKey, child(path, 'rootWorkItemKey')),
    ...optionalStringProperty(record, 'parentWorkItemKey', path),
    ...(record.qa === undefined ? {} : { qa: decodeQa(record.qa, child(path, 'qa')) }),
    ...(record.cohorts === undefined
      ? {}
      : {
          cohorts: array(record.cohorts, child(path, 'cohorts'), (value, path = '') => {
            const row = object(value, path);
            return {
              cohortId: string(row.cohortId, child(path, 'cohortId')),
              settled: boolean(row.settled, child(path, 'settled')),
              ...optionalStringProperty(row, 'failureReason', path),
            };
          }),
        }),
    children: array(record.children, child(path, 'children'), (value, path = '') => {
      const item = object(value, path);
      return {
        workItemKey: string(item.workItemKey, child(path, 'workItemKey')),
        parentWorkItemKey: string(item.parentWorkItemKey, child(path, 'parentWorkItemKey')),
        objective: string(item.objective, child(path, 'objective')),
        workflowName: string(item.workflowName, child(path, 'workflowName')),
        status: string(item.status, child(path, 'status')),
        ...optionalStringProperty(item, 'currentStage', path),
        cohortId: string(item.cohortId, child(path, 'cohortId')),
        ...(item.repository === undefined
          ? {}
          : {
              repository: {
                resourceId: string(
                  object(item.repository, child(path, 'repository')).resourceId,
                  child(path, 'repository.resourceId'),
                ),
                pullRequestBase: string(
                  object(item.repository, child(path, 'repository')).pullRequestBase,
                  child(path, 'repository.pullRequestBase'),
                ),
              },
            }),
        ...(item.prerequisites === undefined
          ? {}
          : { prerequisites: array(item.prerequisites, child(path, 'prerequisites'), string) }),
        ...(item.replaces === undefined
          ? {}
          : {
              replaces: {
                cohortId: string(
                  object(item.replaces, child(path, 'replaces')).cohortId,
                  child(path, 'replaces.cohortId'),
                ),
                assignmentId: string(
                  object(item.replaces, child(path, 'replaces')).assignmentId,
                  child(path, 'replaces.assignmentId'),
                ),
              },
            }),
        ...(item.outputs === undefined
          ? {}
          : {
              outputs: array(item.outputs, child(path, 'outputs'), (value, path = '') => {
                const row = object(value, path);
                return {
                  name: string(row.name, child(path, 'name')),
                  kind: string(row.kind, child(path, 'kind')),
                  required: boolean(row.required, child(path, 'required')),
                  selected: boolean(row.selected, child(path, 'selected')),
                  stale: boolean(row.stale, child(path, 'stale')),
                };
              }),
            }),
        ...optionalStringProperty(item, 'blockReason', path),
        resources: array(item.resources, child(path, 'resources'), decodeResourceItem),
      };
    }),
  };
}

function decodeIntegration(value: unknown, path: string): DeliveryIntegrationResponse {
  const record = object(value, path);
  return {
    complete: boolean(record.complete, child(path, completeField!)),
    summary: string(record.summary, child(path, 'summary')),
    targets: array(record.targets, child(path, 'targets'), (value, path = '') => {
      const row = object(value, path);
      return {
        workItemKey: string(row.workItemKey, child(path, 'workItemKey')),
        outputName: string(row.outputName, child(path, 'outputName')),
        state: string(row.state, child(path, 'state')),
        layer: number(row.layer, child(path, 'layer')),
        baseMovement: string(row.baseMovement, child(path, 'baseMovement')),
        evidenceAffected: boolean(row.evidenceAffected, child(path, 'evidenceAffected')),
        ...optionalStringProperty(row, maintenanceField!, path),
        ...optionalStringProperty(row, 'detail', path),
      };
    }),
    maintenance: array(record.maintenance, child(path, maintenanceField!), (value, path = '') => {
      const row = object(value, path);
      return {
        maintenanceId: string(row.maintenanceId, child(path, 'maintenanceId')),
        workItemKey: string(row.workItemKey, child(path, 'workItemKey')),
        outputName: string(row.outputName, child(path, 'outputName')),
        kind: string(row.kind, child(path, 'kind')),
        previousRevision: string(row.previousRevision, child(path, 'previousRevision')),
        currentRevision: string(row.currentRevision, child(path, 'currentRevision')),
        producerRunId: string(row.producerRunId, child(path, 'producerRunId')),
      };
    }),
  };
}

function decodeQa(value: unknown, path: string) {
  const record = object(value, path);
  return {
    ...(record.integration === undefined
      ? {}
      : { integration: decodeIntegration(record.integration, child(path, integrationField!)) }),
    selectionRevision: number(record.selectionRevision, child(path, 'selectionRevision')),
    ...optionalStringProperty(record, 'candidateId', path),
    repositories: array(record.repositories, child(path, 'repositories'), (value, path = '') => {
      const row = object(value, path);
      return {
        resourceId: string(row.resourceId, child(path, 'resourceId')),
        revision: string(row.revision, child(path, 'revision')),
      };
    }),
    stale: array(record.stale, child(path, 'stale'), string),
    ...(record.staleOutputs === undefined
      ? {}
      : {
          staleOutputs: array(
            record.staleOutputs,
            child(path, 'staleOutputs'),
            (value, path = '') => {
              const row = object(value, path);
              return {
                workItemKey: string(row.workItemKey, child(path, 'workItemKey')),
                outputName: string(row.outputName, child(path, 'outputName')),
                reason: string(row.reason, child(path, 'reason')),
              };
            },
          ),
        }),
    ...optionalStringProperty(record, 'verdict', path),
    effective: boolean(record.effective, child(path, 'effective')),
    canComplete: boolean(record.canComplete, child(path, 'canComplete')),
    ...optionalStringProperty(record, 'reason', path),
    exhausted: boolean(record.exhausted, child(path, 'exhausted')),
    findings: array(record.findings, child(path, 'findings'), string),
  };
}
