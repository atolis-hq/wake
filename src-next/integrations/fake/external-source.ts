import type { ExternalEventSource } from '../github/application/poll-service.js';
import type { GitHubAdapterEventDraft } from '../github/contracts/events.js';

export class FakeExternalEventSource implements ExternalEventSource {
  constructor(private readonly events: readonly GitHubAdapterEventDraft[]) {}

  async poll(signal: AbortSignal): Promise<readonly GitHubAdapterEventDraft[]> {
    void signal;
    return this.events;
  }
}
