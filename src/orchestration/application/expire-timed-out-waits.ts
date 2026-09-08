import type { CommandContext } from '@atolis-hq/eventing';
import { expireTimedOutAwait } from '../domain/interpreter.js';
import type { OrchestrationRepository } from './orchestration-repository.js';

export async function expireTimedOutWaits(
  repository: OrchestrationRepository,
  context: CommandContext,
) {
  const expired = [];
  for (const loaded of await repository.list()) {
    if (loaded.view === null) continue;
    const decision = expireTimedOutAwait(loaded.view, {
      occurredAt: context.occurredAt,
      causationId: context.commandId,
    });
    if (decision.kind === 'ignored') continue;
    await repository.append(loaded.view.workflowInstanceId, loaded.sequence, decision.events);
    expired.push((await repository.loadRequired(loaded.view.workflowInstanceId)).view);
  }
  return expired;
}
