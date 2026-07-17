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

/**
 * An event as returned by a source: no workItemKey. Sources have no
 * obligation to know the work item; the resolver in tick-runner stamps the
 * canonical key between poll and append (ADR 0001 §5, spec D1).
 *
 * `sourceRefs.resourceUri` is what the resolver resolves, so every unkeyed
 * event must carry one — an event without it is a programming error in the
 * adapter, not a case for the resolver to guess an identity for.
 */
export type UnkeyedEventEnvelope = Omit<EventEnvelope, 'workItemKey'>;

export interface WorkSource {
  pollEvents(): Promise<UnkeyedEventEnvelope[]>;
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
    /** Keys the workspace path — one workspace per work item, not per ticket. */
    workId: string;
    /** Still needed to clone. */
    repo: string;
    /** Still needed for the human-readable branch name (spec D2). */
    issueNumber: number;
  }): Promise<{ workspacePath: string; mergeConflictDetected: boolean; upstreamChanges?: string }>;
  prepareReadOnlyClone(input: { repo: string }): Promise<{ workspacePath: string }>;
  cleanupWorkspace(input: {
    workspacePath: string;
  }): Promise<void>;
}
