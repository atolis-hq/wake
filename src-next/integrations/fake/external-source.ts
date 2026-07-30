import type { EventDraft } from '../../kernel/index.js';
import type { ExternalEventSource } from '../github/application/poll-service.js';

export class FakeExternalEventSource implements ExternalEventSource {
  constructor(private readonly events: readonly EventDraft[]) {}

  async poll(_signal: AbortSignal): Promise<readonly EventDraft[]> {
    return this.events;
  }
}
