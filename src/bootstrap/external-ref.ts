import { ResourceCorrelationRole } from '../resources/index.js';
import { workItemId } from '../work/index.js';
import type { CompositionRoot } from './composition-root.js';

// Work items never embed a provider/repo/issue number (see docs/adrs/0001); this joins
// the primary correlated resource's adapter-formatted key at the presentation layer only.
export async function primaryExternalRef(
  root: CompositionRoot,
  rawWorkItemId: string,
): Promise<string | undefined> {
  const correlations = await root.resources.correlationsForWork(workItemId(rawWorkItemId));
  const primary = correlations.find((value) => value.role === ResourceCorrelationRole.Primary);
  if (primary === undefined) return undefined;
  const resource = await root.resources.get(primary.resourceId);
  return resource?.externalKey.key;
}
