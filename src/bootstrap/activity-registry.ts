import {
  ActivityRegistry,
  type AgentContextReader,
  agentActivityDefinition,
  createAgentActivity,
  createIssueCompleteActivity,
  createPullRequestApproveActivity,
  createPullRequestMergeActivity,
  type createPullRequestService,
} from '../activities/index.js';
import { loadPromptTemplate, renderPromptTemplate } from '../execution/index.js';
import type { EventJournal } from '../kernel/index.js';
import type { createResourceService } from '../resources/index.js';
import { createStatusPublishActivity } from './status-publish-activity.js';

export function createBuiltInActivityRegistry(
  journal: EventJournal,
  pullRequests: ReturnType<typeof createPullRequestService>,
  resources: ReturnType<typeof createResourceService>,
  wakeRoot: string,
  contextReader: AgentContextReader,
): ActivityRegistry {
  const activities = new ActivityRegistry();
  activities.register({
    ...agentActivityDefinition,
    handler: createAgentActivity(
      {
        async render(name, context) {
          const template = await loadPromptTemplate(wakeRoot, name);
          return {
            prompt: renderPromptTemplate(template, context),
            ...(template.frontmatter.model === undefined || template.frontmatter.model === null
              ? {}
              : { model: template.frontmatter.model }),
            ...(template.frontmatter.allowedTools === undefined ||
            template.frontmatter.allowedTools === null
              ? {}
              : { allowedTools: template.frontmatter.allowedTools }),
            ...(template.frontmatter.maxTurns === undefined
              ? {}
              : { maxTurns: template.frontmatter.maxTurns }),
          };
        },
      },
      contextReader,
    ),
  });
  activities.register(createStatusPublishActivity(journal));
  activities.register(createIssueCompleteActivity(journal, resources));
  activities.register(createPullRequestApproveActivity(journal, pullRequests));
  activities.register(createPullRequestMergeActivity(journal, pullRequests));
  return activities;
}
