import type {
  AgentAction,
  EventEnvelope,
  IssueStateRecord,
  WakeConfig,
} from '../domain/types.js';

export interface WorkSource {
  pollEvents(): Promise<EventEnvelope[]>;
}

export interface OutboundSink {
  deliverIntent(input: { event: EventEnvelope }): Promise<EventEnvelope[]>;
}

export interface AgentRunTokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AgentRunResult {
  result: string;
  model: string;
  /** Display name of the CLI/agent that produced this result, e.g. "Claude", "Codex". */
  cli: string;
  session_id?: string;
  tokenUsage?: AgentRunTokenUsage;
  metadata?: Record<string, unknown>;
}

export interface AgentRunner {
  run(input: {
    action: AgentAction;
    projection: IssueStateRecord;
    recentEvents: EventEnvelope[];
    config: WakeConfig;
    runId: string;
    workspacePath?: string;
  }): Promise<AgentRunResult>;
}

export interface WorkspaceManager {
  prepareWorkspace(input: {
    repo: string;
    issueNumber: number;
  }): Promise<{ workspacePath: string }>;
  prepareReadOnlyClone(input: { repo: string }): Promise<{ workspacePath: string }>;
  cleanupWorkspace(input: {
    workspacePath: string;
  }): Promise<void>;
}
