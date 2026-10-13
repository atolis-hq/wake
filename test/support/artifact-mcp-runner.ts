import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { FileArtifactMcpSessionStore } from '../../src/artifacts/index.js';
import { createArtifactMcpServerForSession } from '../../src/bootstrap/artifact-mcp.js';
import type { CompositionRoot } from '../../src/bootstrap/index.js';
import {
  RunStatus,
  WakeMcpServerName,
  type AgentRunOutcome,
  type Runner,
  type RunnerRequest,
} from '../../src/execution/index.js';

interface ToolOperation {
  readonly name: string;
  readonly arguments?: Record<string, unknown>;
}

/** Permanent zero-token runner driving the production session and MCP policy. */
export class ArtifactMcpRunner implements Runner {
  readonly name = 'fake';
  readonly supportsEphemeralMcp = true;
  root: CompositionRoot | undefined;
  readonly scripts: { operations: readonly ToolOperation[]; outcome?: AgentRunOutcome }[] = [];
  readonly sessions: { prompt: string; manifest: string; results: unknown[] }[] = [];

  async start(request: RunnerRequest) {
    return { result: this.execute(request), async cancel() {} };
  }

  private async execute(request: RunnerRequest) {
    const root = this.root;
    if (root === undefined) throw new Error('Artifact fake runner must be bound to its root');
    const configured = request.mcpServers?.find((server) => server.name === WakeMcpServerName);
    const path = configured?.args?.[3];
    const token = configured?.env?.WAKE_MCP_TOKEN;
    if (path === undefined || token === undefined) throw new Error('No production MCP capability');
    let count = 0;
    const server = await createArtifactMcpServerForSession(
      root,
      new FileArtifactMcpSessionStore(root.paths.artifactsRoot),
      path,
      token,
      { now: () => new Date().toISOString(), nextId: () => `${request.runId}-artifact-${++count}` },
    );
    const client = new Client({ name: 'artifact-fake', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const script = this.scripts.shift() ?? { operations: [] };
    try {
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
      const listed = await client.callTool({ name: 'wake_artifacts_list' });
      const record = {
        prompt: request.prompt,
        manifest: JSON.stringify(listed),
        results: [] as unknown[],
      };
      this.sessions.push(record);
      for (const operation of script.operations)
        record.results.push(await client.callTool(operation));
      return {
        transport: RunStatus.Succeeded,
        runner: this.name,
        output: JSON.stringify({ status: script.outcome ?? 'DONE' }),
      };
    } finally {
      await client.close();
      await server.close();
    }
  }
}
