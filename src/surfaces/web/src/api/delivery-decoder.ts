import type { ResourceItemResponse } from '../../../api/contracts/resources.js';
import type { WorkDetailResponse } from '../../../api/contracts/work.js';
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

function decodeQa(value: unknown, path: string) {
  const record = object(value, path);
  return {
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
