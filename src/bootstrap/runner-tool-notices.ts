import { BuiltInActivityName, agentActivityDefinition } from '../activities/index.js';
import { RunnerKind } from '../execution/index.js';
import type { ResolvedWakeModulesConfig } from './config/root-schema.js';

export function runnerToolNotices(config: ResolvedWakeModulesConfig): string[] {
  const notices: string[] = [];
  for (const [workflowName, workflow] of Object.entries(config.orchestration.workflows)) {
    for (const [stageName, stage] of Object.entries(workflow.stages)) {
      if (stage.activity !== BuiltInActivityName.Agent) continue;
      if (!hasToolList(stage.with)) continue;
      const pool = stage.execution?.runnerPool ?? config.execution.defaultRunnerPool;
      for (const runner of config.execution.runnerPools[pool] ?? []) {
        if (config.execution.agentRunners?.[runner]?.kind !== RunnerKind.CodexCli) continue;
        notices.push(
          `Workflow "${workflowName}" stage "${stageName}": allowedTools is advisory and is not enforced by Codex runner "${runner}" (pool "${pool}").`,
        );
      }
    }
  }
  return notices;
}

function hasToolList(input: unknown): boolean {
  const parsed = agentActivityDefinition.inputSchema.safeParse(input);
  return parsed.success && (parsed.data.allowedTools?.length ?? 0) > 0;
}
