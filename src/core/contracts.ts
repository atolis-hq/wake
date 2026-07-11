import type {
  AgentAction,
  EventEnvelope,
  IssueStateRecord,
  RunnerFailureClass,
  RunnerRouting,
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
  // Cache tokens dominate real agent-run cost/volume and were previously
  // dropped entirely, understating usage by roughly an order of magnitude
  // (#135). Present only when the CLI's structured output reports them.
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  costUsd?: number;
  turns?: number;
}

export interface AgentRunResult {
  result: string;
  model: string;
  /** Display name of the CLI/agent that produced this result, e.g. "Claude", "Codex". */
  cli: string;
  session_id?: string;
  tokenUsage?: AgentRunTokenUsage;
  failureClass?: RunnerFailureClass;
  routing?: RunnerRouting;
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
    routing?: RunnerRouting;
    mergeConflictDetected?: boolean;
  }): Promise<AgentRunResult>;
}

export interface WorkspaceManager {
  prepareWorkspace(input: {
    repo: string;
    issueNumber: number;
  }): Promise<{ workspacePath: string; mergeConflictDetected: boolean }>;
  prepareReadOnlyClone(input: { repo: string }): Promise<{ workspacePath: string }>;
  cleanupWorkspace(input: {
    workspacePath: string;
  }): Promise<void>;
}
