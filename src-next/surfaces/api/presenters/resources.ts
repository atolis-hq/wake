import type { ResourceView } from '../../../resources/index.js';
import type { ResourceItemResponse } from '../contracts/resources.js';

export function presentResource(value: ResourceView): ResourceItemResponse {
  return {
    resourceId: value.resourceId,
    kind: value.kind,
    capabilities: value.capabilities,
    ...(value.revision === undefined ? {} : { revision: value.revision }),
  };
}
