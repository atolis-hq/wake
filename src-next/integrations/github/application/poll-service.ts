import { EventSourceKind } from '../../../kernel/index.js';
import type { EventJournal } from '../../../kernel/index.js';
import { GitHubEventType, type GitHubAdapterEventDraft } from '../contracts/events.js';
import { GitHubAdapter } from '../contracts/vocabulary.js';
import { integrationStream } from '../../contracts/streams.js';

export interface ExternalEventSource {
  poll(signal: AbortSignal): Promise<readonly GitHubAdapterEventDraft[]>;
}

const gitHubEventTypes = new Set<string>(Object.values(GitHubEventType));

export class PollService {
  constructor(
    private readonly journal: EventJournal,
    private readonly source: ExternalEventSource,
  ) {}

  async pollOnce(signal: AbortSignal): Promise<void> {
    const drafts = await this.source.poll(signal);
    for (const draft of drafts) {
      if (draft.source.kind !== EventSourceKind.Adapter || draft.source.id !== 'github') {
        throw new Error('PollService accepts GitHub adapter evidence only');
      }
      if (!gitHubEventTypes.has(draft.eventType)) {
        throw new Error('PollService cannot append canonical domain events');
      }
    }
    if (drafts.length === 0) return;
    const stream = integrationStream(GitHubAdapter);
    const existing = await this.journal.readStream(stream);
    await this.journal.append(
      stream,
      existing.length,
      drafts.map((draft) => ({ ...draft, stream })),
    );
  }
}
