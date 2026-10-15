import { activityName, type ActivityRegistry } from '../../activities/index.js';
import type { CompiledSupplementalCommand, WorkflowDefinitionConfig } from '../contracts/config.js';
import { commandName } from '../contracts/identifiers.js';

export function compileCommands(
  config: WorkflowDefinitionConfig,
  activities: ActivityRegistry,
): Record<ReturnType<typeof commandName>, CompiledSupplementalCommand> {
  return Object.fromEntries(
    Object.entries(config.commands ?? {}).map(([command, configured]) => [
      commandName(command),
      Object.freeze({
        activity: activityName(configured.activity),
        with: activities.validateInput(activityName(configured.activity), configured.with),
        allowedActors: Object.freeze([...configured.allowedActors]),
      }),
    ]),
  ) as Record<ReturnType<typeof commandName>, CompiledSupplementalCommand>;
}
