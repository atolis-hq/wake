import { BuiltInActivityName, agentActivityDefinition } from '../activities/index.js';
import { RunnerKind, type PromptTemplate } from '../execution/index.js';
import type { ResolvedWakeModulesConfig } from './config/root-schema.js';

export function runnerToolNotices(
  config: ResolvedWakeModulesConfig,
  templates: ReadonlyMap<string, PromptTemplate> = new Map(),
): string[] {
  const notices: string[] = [];
  for (const [workflowName, workflow] of Object.entries(config.orchestration.workflows)) {
    for (const [stageName, stage] of Object.entries(workflow.stages)) {
      if (stage.activity !== BuiltInActivityName.Agent) continue;
      if (!hasToolList(stage.with, templates)) continue;
      const pool = stage.execution?.runnerPool ?? config.execution.defaultRunnerPool;
      const codexRunners = (config.execution.runnerPools[pool] ?? []).filter(
        (runner) => config.execution.agentRunners?.[runner]?.kind === RunnerKind.CodexCli,
      );
      for (const runner of codexRunners) {
        notices.push(
          `Workflow "${workflowName}" stage "${stageName}": allowedTools is advisory and is not enforced by Codex runner "${runner}" (pool "${pool}").`,
        );
      }
    }
  }
  return notices;
}

function hasToolList(input: unknown, templates: ReadonlyMap<string, PromptTemplate>): boolean {
  const parsed = agentActivityDefinition.inputSchema.safeParse(input);
  if (!parsed.success) return false;
  const stage = parsed.data;
  if (stage.template !== undefined && !templates.has(stage.template)) return false;
  const templateTools =
    stage.template === undefined
      ? undefined
      : templates.get(stage.template)?.frontmatter.allowedTools;
  return (stage.allowedTools ?? templateTools ?? []).length > 0;
}
