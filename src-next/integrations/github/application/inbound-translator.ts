import {
  correlationId,
  type CheckpointStore,
  type CommandContext,
  type EventEnvelope,
  type EventJournal,
} from '../../../kernel/index.js';
import type { ResourceService } from '../../../resources/index.js';
import { resourceId, type ResourceId } from '../../../resources/index.js';
import type { WorkService } from '../../../work/index.js';
import { workItemId, type WorkItemId } from '../../../work/index.js';
import type { ExternalWorkObservedPayload, GitHubAdapterEvent } from '../contracts/events.js';

export type InboundCommandCandidate =
  | {
      readonly kind: 'discover-resource';
      readonly resourceId: ResourceId;
      readonly externalKey: { readonly adapter: 'github'; readonly key: string };
      readonly revision: string;
    }
  | {
      readonly kind: 'create-work-item';
      readonly workItemId: WorkItemId;
      readonly objective: string;
    }
  | {
      readonly kind: 'correlate-resource';
      readonly resourceId: ResourceId;
      readonly workItemId: WorkItemId;
    };

const checkpoint = 'reactor:integration.github.inbound';

export class InboundTranslator {
  translate(payload: ExternalWorkObservedPayload): readonly InboundCommandCandidate[] {
    const resourceIdValue = externalResourceId(payload.externalKey);
    const workItemIdValue = externalWorkItemId(payload.externalKey);
    return [
      {
        kind: 'discover-resource',
        resourceId: resourceIdValue,
        externalKey: { adapter: 'github', key: payload.externalKey },
        revision: payload.revision,
      },
      { kind: 'create-work-item', workItemId: workItemIdValue, objective: payload.title },
      { kind: 'correlate-resource', resourceId: resourceIdValue, workItemId: workItemIdValue },
    ];
  }

  constructor(
    private readonly journal?: EventJournal,
    private readonly checkpoints?: CheckpointStore,
    private readonly work?: WorkService,
    private readonly resources?: ResourceService,
  ) {}

  async runOnce(limit = 100): Promise<void> {
    if (
      this.journal === undefined ||
      this.checkpoints === undefined ||
      this.work === undefined ||
      this.resources === undefined
    ) {
      throw new Error('InboundTranslator services are required to run evidence translation');
    }
    const position = await this.checkpoints.load(checkpoint);
    const events = await this.journal.readAll(position, limit);
    for (const event of events) {
      if (event.eventType === 'integration.github.work-observed') {
        await this.apply(event as GitHubAdapterEvent);
      }
      await this.checkpoints.save(checkpoint, event.globalPosition);
    }
  }

  private async apply(event: GitHubAdapterEvent): Promise<void> {
    if (event.eventType !== 'integration.github.work-observed') return;
    if (this.work === undefined || this.resources === undefined) return;
    const payload = event.payload;
    const context = commandContext(event);
    const current = await this.resources.findByExternalKey({
      adapter: 'github',
      key: payload.externalKey,
    });
    if (current !== null) {
      if (current.revision !== payload.revision) {
        await this.resources.discover(
          {
            resourceId: current.resourceId,
            kind: current.kind,
            externalKey: current.externalKey,
            capabilities: current.capabilities,
            revision: payload.revision,
          },
          context,
        );
      }
      return;
    }
    const resourceIdValue = externalResourceId(payload.externalKey);
    const workItemIdValue = externalWorkItemId(payload.externalKey);
    await this.resources.discover(
      {
        resourceId: resourceIdValue,
        kind: payload.kind,
        externalKey: { adapter: 'github', key: payload.externalKey },
        capabilities:
          payload.kind === 'pull-request'
            ? ['commentable', 'reviewable', 'revisioned']
            : ['commentable'],
        revision: payload.revision,
      },
      context,
    );
    await this.work.create({ workItemId: workItemIdValue, objective: payload.title }, context);
    await this.resources.correlate(resourceIdValue, workItemIdValue, 'primary', context);
  }
}

function commandContext(event: EventEnvelope): CommandContext {
  return {
    commandId: `${event.eventId}:inbound`,
    correlationId: correlationId(event.correlationId),
    occurredAt: event.occurredAt,
    actor: { kind: 'integration', id: 'github' },
  };
}

function stableSuffix(externalKey: string): string {
  return externalKey
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function externalResourceId(externalKey: string): ResourceId {
  return resourceId(`resource-github-${stableSuffix(externalKey)}`);
}

function externalWorkItemId(externalKey: string): WorkItemId {
  return workItemId(`work-github-${stableSuffix(externalKey)}`);
}
