import type { ResourceLinkResolver, ResourceView } from '../../../resources/index.js';
import type { ResourceItemResponse } from '../contracts/resources.js';

export function presentResource(
  resolveLink: ResourceLinkResolver,
): (value: ResourceView) => ResourceItemResponse {
  return (value) => {
    const externalUrl = resolveLink(value.externalKey);
    return {
      resourceId: value.resourceId,
      adapter: value.externalKey.adapter,
      kind: value.kind,
      locatorLabel: `${value.kind} ${value.externalKey.key}`,
      capabilities: value.capabilities,
      ...(value.title === undefined ? {} : { title: value.title }),
      ...(externalUrl === null ? {} : { externalUrl }),
      ...(value.revision === undefined ? {} : { revision: value.revision }),
    };
  };
}
