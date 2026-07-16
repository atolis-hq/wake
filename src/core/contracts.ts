import type {
  AgentAction,
  EventEnvelope,
  IssueStateRecord,
  RunnerFailureClass,
  RunnerRouting,
  WakeConfig,
} from '../domain/types.js';

// Declared here (not in the concrete fs adapter) so the seam direction
// matches every other adapter contract in this file: core/ declares the
// interface, the adapter imports and implements it. Only main.ts's
// buildRuntime wires the concrete createResourceIndex() in.
export interface ResourceIndex {
  resolve(resourceUri: string): Promise<string | undefined>;
  register(resourceUri: string, workItemKey: string): Promise<void>;
  retract(resourceUri: string): Promise<void>;
  replaceAll(entries: ReadonlyMap<string, string>): Promise<void>;
}

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
    upstreamChanges?: string;
  }): Promise<AgentRunResult>;
}

export interface WorkspaceManager {
  prepareWorkspace(input: {
    repo: string;
    issueNumber: number;
  }): Promise<{ workspacePath: string; mergeConflictDetected: boolean; upstreamChanges?: string }>;
  prepareReadOnlyClone(input: { repo: string }): Promise<{ workspacePath: string }>;
  cleanupWorkspace(input: {
    workspacePath: string;
  }): Promise<void>;
}
