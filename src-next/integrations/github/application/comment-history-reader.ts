import type { EventJournal } from '../../../kernel/index.js';
import { ResourceCorrelationRole, type ResourceService } from '../../../resources/index.js';
import type { WorkItemId } from '../../../work/index.js';
import { adapterId } from '../../contracts/identifiers.js';
import { integrationStream } from '../../contracts/streams.js';
import { GitHubEventType, selectGitHubAdapterEvent } from '../contracts/events.js';

export interface CommentHistoryEntry {
  readonly author: string;
  readonly occurredAt: string;
  readonly body: string;
}

export interface CommentHistoryReader {
  forWorkItem(workItemId: WorkItemId): Promise<readonly CommentHistoryEntry[]>;
}

export function createCommentHistoryReader(
  journal: EventJournal,
  resources: Pick<ResourceService, 'correlationsForWork' | 'get'>,
): CommentHistoryReader {
  return {
    async forWorkItem(workItemId) {
      const primary = (await resources.correlationsForWork(workItemId)).find(
        (correlation) => correlation.role === ResourceCorrelationRole.Primary,
      );
      if (primary === undefined) return [];

      const resource = await resources.get(primary.resourceId);
      if (resource === null) return [];
      const adapter = parseAdapterId(resource.externalKey.adapter);
      if (adapter === null) return [];

      return (await journal.readStream(integrationStream(adapter))).flatMap((event) => {
        const observed = selectGitHubAdapterEvent(event);
        if (observed?.eventType !== GitHubEventType.CommentObserved) return [];
        if (observed.payload.externalKey !== resource.externalKey.key) return [];
        return [
          {
            author: observed.payload.actor.id,
            occurredAt: observed.occurredAt,
            body: observed.payload.body,
          },
        ];
      });
    },
  };
}

function parseAdapterId(value: string) {
  try {
    return adapterId(value);
  } catch {
    return null;
  }
}
