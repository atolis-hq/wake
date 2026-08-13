import type { EventJournal } from '../../../kernel/index.js';
import { ResourceCorrelationRole, type ResourceService } from '../../../resources/index.js';
import type { WorkItemId } from '../../../work/index.js';
import { adapterId } from '../../contracts/identifiers.js';
import { GitHubEventType, selectGitHubAdapterEvent } from '../contracts/events.js';

export interface CommentHistoryEntry {
  readonly author: string;
  readonly occurredAt: string;
  readonly body: string;
  readonly location?: {
    readonly path: string;
    readonly line: number;
    readonly side: 'LEFT' | 'RIGHT';
  };
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
      const keys = new Set(
        (
          await Promise.all(
            (await resources.correlationsForWork(workItemId))
              .filter((correlation) => correlation.role === ResourceCorrelationRole.Primary)
              .map((correlation) => resources.get(correlation.resourceId)),
          )
        ).flatMap((resource) => {
          if (resource === null || parseAdapterId(resource.externalKey.adapter) === null) return [];
          return [`${resource.externalKey.adapter}:${resource.externalKey.key}`];
        }),
      );
      if (keys.size === 0) return [];
      return (await journal.readAll(0)).flatMap((event) => {
        const observed = selectGitHubAdapterEvent(event);
        if (observed?.eventType !== GitHubEventType.CommentObserved) return [];
        if (!keys.has(`${observed.stream.id}:${observed.payload.externalKey}`)) return [];
        return [
          {
            author: observed.payload.actor.id,
            occurredAt: observed.occurredAt,
            body: observed.payload.body,
            ...(observed.payload.reviewKind !== 'issue' || observed.payload.location === undefined
              ? {}
              : { location: observed.payload.location }),
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
