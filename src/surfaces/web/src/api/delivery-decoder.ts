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
    children: array(record.children, child(path, 'children'), (value, path = '') => {
      const item = object(value, path);
      return {
        workItemKey: string(item.workItemKey, child(path, 'workItemKey')),
        parentWorkItemKey: string(item.parentWorkItemKey, child(path, 'parentWorkItemKey')),
        objective: string(item.objective, child(path, 'objective')),
        workflowName: string(item.workflowName, child(path, 'workflowName')),
        status: string(item.status, child(path, 'status')),
        cohortId: string(item.cohortId, child(path, 'cohortId')),
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
    ...optionalStringProperty(record, 'verdict', path),
    effective: boolean(record.effective, child(path, 'effective')),
    canComplete: boolean(record.canComplete, child(path, 'canComplete')),
    ...optionalStringProperty(record, 'reason', path),
    exhausted: boolean(record.exhausted, child(path, 'exhausted')),
    findings: array(record.findings, child(path, 'findings'), string),
  };
}
