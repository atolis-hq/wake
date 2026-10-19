import type { ResourceItemResponse } from '../../../api/contracts/resources.js';
import type { WorkDetailResponse } from '../../../api/contracts/work.js';
import type { Decoder } from './decoder-primitives.js';
import { array, child, object, optionalStringProperty, string } from './decoder-primitives.js';

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
