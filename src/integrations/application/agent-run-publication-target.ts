import {
  BuiltInResourceKind,
  ResourceCorrelationProvenance,
  ResourceCorrelationRole,
  type ResourceCorrelationView,
  type ResourceService,
} from '../../resources/index.js';
import type { WorkService } from '../../work/index.js';
import { ReplyTarget, type ReplyPublicationConfig } from '../contracts/reply-routing.js';

/** The resource a work item's reply should be published on, or undefined when it has none. */
export async function resourceForTarget(
  resources: Pick<ResourceService, 'correlationsForWork' | 'get'>,
  workItemId: Parameters<ResourceService['correlationsForWork']>[0],
  target: Exclude<ReplyPublicationConfig['default'], typeof ReplyTarget.None>,
): Promise<ResourceCorrelationView | undefined> {
  const correlations = await resources.correlationsForWork(workItemId);
  const primary = () =>
    correlations.find((value) => value.role === ResourceCorrelationRole.Primary);
  const delegated = () =>
    correlations.find((value) => value.provenance === ResourceCorrelationProvenance.Delegated);
  // A child has no primary resource of its own until it reports a PR; until then it speaks on
  // the resource its parent delegated it from.
  if (target === ReplyTarget.Primary) return primary() ?? delegated();
  const kind =
    target === ReplyTarget.Issue ? BuiltInResourceKind.Issue : BuiltInResourceKind.PullRequest;
  for (const correlation of correlations) {
    const resource = await resources.get(correlation.resourceId);
    if (resource?.kind === kind) return correlation;
  }
  return primary();
}

/**
 * A delegated child publishes onto its parent's resource, shared with its siblings, so its
 * comment names the work it speaks for. The child's own conversation entry stays unlabelled.
 */
export async function labelledForSharedResource<Report extends { readonly displayBody: string }>(
  work: Pick<WorkService, 'get'> | undefined,
  workItemId: Parameters<ResourceService['correlationsForWork']>[0],
  resource: ResourceCorrelationView,
  report: Report,
): Promise<Report> {
  if (resource.provenance !== ResourceCorrelationProvenance.Delegated) return report;
  const objective = (await work?.get(workItemId))?.objective;
  if (objective === undefined) return report;
  return { ...report, displayBody: `**Child work:** ${objective}\n\n${report.displayBody}` };
}
