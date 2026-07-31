import type { CommandContext } from '../../../kernel/index.js';
import { ResourceCorrelationRole, type ResourceId } from '../../../resources/index.js';
import type { WorkItemId } from '../../../work/index.js';

export interface ResourceCorrelationApplication {
  correlate(
    resourceId: ResourceId,
    workItemId: WorkItemId,
    role: ResourceCorrelationRole,
    context: CommandContext,
  ): Promise<unknown>;
}
export const correlate = (
  application: ResourceCorrelationApplication,
  resource: ResourceId,
  workItemId: WorkItemId,
  context: CommandContext,
) => application.correlate(resource, workItemId, ResourceCorrelationRole.Primary, context);
