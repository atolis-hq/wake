import type { ResourceView } from '../contracts/views.js';
import { BuiltInResourceKind } from '../contracts/vocabulary.js';

/** Match workspace kind precedence, with stable identity ordering within a kind. */
export function repositoryCandidate(resources: readonly ResourceView[]): ResourceView | undefined {
  const kinds = [
    BuiltInResourceKind.Repository,
    BuiltInResourceKind.PullRequest,
    BuiltInResourceKind.Issue,
  ];
  return resources
    .filter((resource) => kinds.includes(resource.kind))
    .sort(
      (a, b) =>
        kinds.indexOf(a.kind) - kinds.indexOf(b.kind) ||
        (a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0),
    )[0];
}
