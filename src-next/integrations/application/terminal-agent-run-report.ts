import type { AgentRunPublicationReport } from '../delivery/contracts/intents.js';

export interface TerminalRunAgentResult {
  readonly outcome: 'DONE' | 'REJECTED' | 'BLOCKED' | 'FAILED';
  readonly displayBody: string;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

export interface TerminalRunFailure {
  readonly message: string;
}

export interface TerminalRun {
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly runner?:
    | {
        readonly name: string;
        readonly model?: string | undefined;
        readonly pool?: string | undefined;
        readonly cli?: string | undefined;
      }
    | undefined;
  readonly workspace?: { readonly path: string } | undefined;
  readonly agent?: TerminalRunAgentResult | undefined;
  readonly failure?: TerminalRunFailure | undefined;
}

export function projectTerminalAgentRunReport(input: {
  readonly run: TerminalRun;
  readonly stage?: string;
  readonly awaitingApproval?: boolean;
  readonly watchGateVerdict?: { readonly runId: string };
}): AgentRunPublicationReport | null {
  if (input.run.finishedAt === undefined) return null;
  const agent = input.run.agent;
  return {
    runId: input.run.runId,
    ...(input.stage === undefined ? {} : { stage: input.stage }),
    ...runnerFields(input.run.runner),
    startedAt: input.run.startedAt,
    finishedAt: input.run.finishedAt,
    displayBody: displayBodyFor(agent, input.run.failure),
    outcome: agent?.outcome ?? 'FAILED',
    ...sessionIdField(agent),
    ...(input.run.workspace === undefined ? {} : { workspacePath: input.run.workspace.path }),
    metadata: agent?.metadata ?? {},
    ...(input.awaitingApproval === true ? { awaitingApproval: true } : {}),
    ...(input.watchGateVerdict === undefined ? {} : { watchGateVerdict: input.watchGateVerdict }),
  };
}

function runnerFields(runner: TerminalRun['runner']) {
  if (runner === undefined) return {};
  return {
    runner: runner.name,
    ...(runner.model === undefined ? {} : { model: runner.model }),
    ...(runner.pool === undefined ? {} : { runnerPool: runner.pool }),
    ...(runner.cli === undefined ? {} : { cli: runner.cli }),
  };
}

function displayBodyFor(
  agent: TerminalRunAgentResult | undefined,
  failure: TerminalRunFailure | undefined,
): string {
  if (agent?.displayBody !== undefined && agent.displayBody.length > 0) return agent.displayBody;
  if (failure?.message !== undefined && failure.message.length > 0) return failure.message;
  return 'Runner failed without a response.';
}

function sessionIdField(agent: TerminalRunAgentResult | undefined) {
  const sessionId = agent?.metadata.sessionId;
  return typeof sessionId === 'string' ? { sessionId } : {};
}
