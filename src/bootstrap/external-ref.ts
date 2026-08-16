import {
  ResourceCorrelationRole,
  type ResourceCorrelationView,
  type ResourceView,
} from '../resources/index.js';
import { workItemId } from '../work/index.js';
import type { CompositionRoot } from './composition-root.js';

// Work items never embed a provider/repo/issue number (see docs/adrs/0001); this joins
// the primary correlated resource's adapter-formatted key at the presentation layer only.
export async function primaryExternalRef(
  root: CompositionRoot,
  rawWorkItemId: string,
  suppliedCorrelations?: readonly ResourceCorrelationView[],
  suppliedResources?: readonly ResourceView[],
): Promise<string | undefined> {
  const correlations =
    suppliedCorrelations ?? (await root.resources.correlationsForWork(workItemId(rawWorkItemId)));
  const primary = correlations.find((value) => value.role === ResourceCorrelationRole.Primary);
  if (primary === undefined) return undefined;
  const resource =
    suppliedResources?.find((value) => value.resourceId === primary.resourceId) ??
    (await root.resources.get(primary.resourceId));
  return resource?.externalKey.key;
}
