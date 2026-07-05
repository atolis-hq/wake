import type {
  AgentAction,
  IssueStateRecord,
  WakeConfig,
} from '../domain/types.js';

export interface WorkSource {
  syncIssues(): Promise<IssueStateRecord[]>;
}

export interface AgentRunResult {
  result: string;
  session_id?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentRunner {
  run(input: {
    action: AgentAction;
    issue: IssueStateRecord;
    config: WakeConfig;
  }): Promise<AgentRunResult>;
}

export interface WorkspaceManager {
  prepareWorkspace(input: {
    repo: string;
    issueNumber: number;
  }): Promise<{ workspacePath: string }>;
  cleanupWorkspace(input: {
    workspacePath: string;
  }): Promise<void>;
}
