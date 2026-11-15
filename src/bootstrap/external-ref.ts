import {
  ResourceCorrelationRole,
  type ResourceCorrelationView,
  type ResourceView,
} from '../resources/index.js';
import { workItemId } from '../work/index.js';
import type { CompositionRoot } from './composition-root.js';

// Work items never embed a provider/repo/issue number (see project/adrs/0001); this joins
// the primary correlated resource's adapter-formatted key at the presentation layer only.
export async function primaryExternalRef(
  root: CompositionRoot,
  rawWorkItemId: string,
  suppliedCorrelations?: readonly ResourceCorrelationView[],
  suppliedResources?: readonly ResourceView[],
): Promise<string | undefined> {
  const resource = await primaryResource(
    root,
    rawWorkItemId,
    suppliedCorrelations,
    suppliedResources,
  );
  return resource?.externalKey.key;
}

// Generic "repository" display field; only adapters that know a repository identity supply one.
export async function primaryRepository(
  root: CompositionRoot,
  rawWorkItemId: string,
): Promise<string | undefined> {
  const resource = await primaryResource(root, rawWorkItemId);
  return resource === undefined
    ? undefined
    : root.resolveResourceRepositoryIdentity(resource.externalKey);
}

async function primaryResource(
  root: CompositionRoot,
  rawWorkItemId: string,
  suppliedCorrelations?: readonly ResourceCorrelationView[],
  suppliedResources?: readonly ResourceView[],
): Promise<ResourceView | undefined> {
  const correlations =
    suppliedCorrelations ?? (await root.resources.correlationsForWork(workItemId(rawWorkItemId)));
  const primary = correlations.find((value) => value.role === ResourceCorrelationRole.Primary);
  if (primary === undefined) return undefined;
  return (
    suppliedResources?.find((value) => value.resourceId === primary.resourceId) ??
    (await root.resources.get(primary.resourceId)) ??
    undefined
  );
}
