import type { ArtifactContextService, ArtifactRevisionReference } from '../artifacts/index.js';
import type { WorkService } from '../work/index.js';

/** Accepted artifact revisions a parent granted to one of its delegated children. */
export function delegatedGrantReferences(input: {
  readonly work: Pick<WorkService, 'get'>;
  readonly contexts: Pick<ArtifactContextService, 'childReferences'>;
}): (workItemId: string) => Promise<readonly ArtifactRevisionReference[]> {
  return async (workItemId) => {
    const parent = (await input.work.get(workItemId as never))?.delegation?.parentWorkItemId;
    return parent === undefined ? [] : input.contexts.childReferences(parent, workItemId as never);
  };
}

type SharedContext = (workItemId: string) => Promise<{
  readonly sharedReferences?: readonly ArtifactRevisionReference[];
  readonly currentMemory?: ArtifactRevisionReference | null;
  readonly contextScope?: string;
}>;

/** Makes a child's granted references readable by its activations, beside trigger-shared context. */
export function withDelegatedGrants(
  shared: SharedContext,
  grants: (workItemId: string) => Promise<readonly ArtifactRevisionReference[]>,
): SharedContext {
  return async (workItemId) => {
    const base = await shared(workItemId);
    const granted = await grants(workItemId);
    return granted.length === 0
      ? base
      : { ...base, sharedReferences: [...(base.sharedReferences ?? []), ...granted] };
  };
}
