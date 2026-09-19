import { EventActorKind, correlationId, type CommandContext } from '@atolis-hq/eventing';
import { randomUUID } from 'node:crypto';
import type { FileArtifactMcpSessionStore } from '../artifacts/index.js';
import {
  createArtifactMcpServer,
  type ArtifactMcpSessionDescriptor,
  type ArtifactService,
} from '../artifacts/index.js';
import type { ExecutionDependencies } from '../execution/index.js';
import {
  TransitionTargetKind,
  type CompiledWorkflow,
  type OrchestrationService,
} from '../orchestration/index.js';

const sessionLifetimeMs = 2 * 60 * 60 * 1000;

/** Bootstrap binds Artifact's generic policy to verified Execution and Orchestration facts. */
export function createArtifactMcpProvisioner(input: {
  readonly artifacts: ArtifactService;
  readonly orchestration: OrchestrationService;
  readonly sessions: FileArtifactMcpSessionStore;
  readonly wakeRoot: string;
  readonly now: () => string;
  readonly nextId: () => string;
}): NonNullable<ExecutionDependencies['mcp']> {
  return async ({ runId, activation, context }) => {
    const workflow = await input.orchestration.get(context.workflowInstanceId);
    if (workflow === null) throw new Error(`Workflow ${context.workflowInstanceId} was not found`);
    const producer = producerFor(context.workflowInstanceId, activation.stage, activation.activity);
    const readableProducers = new Set([
      producer,
      ...(await upstreamProducers(
        input.orchestration,
        workflow,
        context.workflowInstanceId,
        activation.stage,
      )),
    ]);
    const expiresAt = new Date(Date.parse(input.now()) + sessionLifetimeMs).toISOString();
    const descriptor: ArtifactMcpSessionDescriptor = {
      workItemId: context.workItemId,
      producer,
      runId,
      activationId: activation.activationId,
      readableProducers: [...readableProducers],
      expiresAt,
    };
    const issued = await input.sessions.issue(descriptor);
    try {
      const manifest = await input.artifacts.visibleTo(
        { ...descriptor, readableProducers },
        acceptedActivation(input.orchestration, context.workItemId),
      );
      return {
        servers: [
          {
            name: 'wake',
            command: 'wake',
            args: ['mcp', 'serve', '--session', issued.path, '--wake-root', input.wakeRoot],
            env: { WAKE_MCP_TOKEN: issued.token },
          },
        ],
        prompt: artifactPrompt(manifest),
        release: () => input.sessions.revoke(issued.path),
      };
    } catch (error) {
      await input.sessions.revoke(issued.path);
      throw error;
    }
  };
}

/** Creates the transport-neutral Wake MCP server for the run-bound CLI command. */
export async function createArtifactMcpServerForSession(
  root: ArtifactMcpRoot,
  sessions: FileArtifactMcpSessionStore,
  path: string,
  token: string,
  options: { readonly now: () => string; readonly nextId: () => string },
) {
  const descriptor = await sessions.read(path, token);
  const accepted = acceptedActivation(root.orchestration, descriptor.workItemId);
  return createArtifactMcpServer(root.artifacts, {
    ...descriptor,
    readableProducers: new Set(descriptor.readableProducers),
    nextRevisionId: options.nextId,
    commandContext: () => commandContext(options.now(), descriptor),
    acceptedActivation: accepted,
    assertActive: async () => {
      await sessions.read(path, token);
    },
  });
}

interface ArtifactMcpRoot {
  readonly artifacts: ArtifactService;
  readonly orchestration: OrchestrationService;
}

function commandContext(
  occurredAt: string,
  descriptor: ArtifactMcpSessionDescriptor,
): CommandContext {
  return {
    commandId: `artifact-mcp:${descriptor.runId}:${randomUUID()}`,
    correlationId: correlationId(`artifact:${descriptor.runId}`),
    actor: { kind: EventActorKind.System, id: 'wake-mcp' },
    occurredAt,
  };
}

function acceptedActivation(orchestration: OrchestrationService, workItemId: string) {
  let accepted: Promise<ReadonlySet<string>> | undefined;
  return async (activationId: string) => {
    accepted ??= orchestration
      .listForWorkItem(workItemId as never)
      .then((workflows) => new Set(workflows.flatMap((workflow) => workflow.acceptedOutcomes)));
    return (await accepted).has(activationId);
  };
}

async function upstreamProducers(
  orchestration: OrchestrationService,
  workflow: Parameters<OrchestrationService['definitionFor']>[0],
  workflowInstanceId: string,
  stage: string | undefined,
): Promise<readonly string[]> {
  if (stage === undefined) return [];
  const definition = await orchestration.definitionFor(workflow);
  return [...upstreamStages(definition, stage)].map((candidate) =>
    producerFor(workflowInstanceId, candidate),
  );
}

function upstreamStages(definition: CompiledWorkflow, stage: string): ReadonlySet<string> {
  const predecessors = new Map<string, Set<string>>();
  for (const [source, configured] of Object.entries(definition.stages)) {
    for (const route of Object.values(configured.on)) {
      for (const target of [route.target, route.reentryTarget]) {
        if (target.kind !== TransitionTargetKind.Stage) continue;
        const entries = predecessors.get(target.stage) ?? new Set<string>();
        entries.add(source);
        predecessors.set(target.stage, entries);
      }
    }
  }
  const found = new Set<string>();
  const pending = [...(predecessors.get(stage) ?? [])];
  while (pending.length > 0) {
    const candidate = pending.pop()!;
    if (candidate === stage || found.has(candidate)) continue;
    found.add(candidate);
    pending.push(...(predecessors.get(candidate) ?? []));
  }
  return found;
}

function producerFor(
  workflowInstanceId: string,
  stage: string | undefined,
  activity?: string,
): string {
  return `${workflowInstanceId}/${stage ?? `activation-${activity ?? ''}`}`;
}

function artifactPrompt(
  manifest: readonly {
    readonly revisionId: string;
    readonly producer: string;
    readonly path: string;
    readonly mediaType?: string;
    readonly byteLength?: number;
    readonly digest?: string;
    readonly location?: string;
  }[],
): string {
  return [
    'Wake artifacts are available through the trusted Wake MCP tools.',
    'The manifest contains metadata only; read content explicitly when useful. Write output through Wake tools, not Git.',
    JSON.stringify(manifest.map(({ location: _location, ...artifact }) => artifact)),
  ].join('\n');
}
