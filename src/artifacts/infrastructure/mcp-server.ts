import type { CommandContext } from '@atolis-hq/eventing';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WorkItemId } from '../../work/index.js';
import type { ArtifactService } from '../application/artifact-service.js';
import type {
  ArtifactRevisionReference,
  OperatorInstructionsDocument,
} from '../contracts/context.js';
import { artifactPath } from '../contracts/paths.js';

/** A capability token is resolved into this server-side scope by Execution. */
export interface ArtifactMcpSession {
  readonly workItemId: WorkItemId;
  readonly producer: string;
  readonly runId: string;
  readonly activationId: string;
  readonly readableProducers: ReadonlySet<string>;
  readonly sharedReferences?: readonly ArtifactRevisionReference[];
  readonly currentMemory?: ArtifactRevisionReference | null;
  readonly contextScope?: string;
  readonly operatorInstructions?: OperatorInstructionsDocument;
  readonly nextRevisionId: () => string;
  readonly commandContext: () => CommandContext;
  readonly acceptedActivation: (activationId: string, workItemId?: string) => Promise<boolean>;
  /** Revalidates the run-bound credential for every tool request. */
  readonly assertActive: () => Promise<void>;
}

// Tool registration remains adjacent so the advertised MCP surface is auditable in one place.
// eslint-disable-next-line max-lines-per-function
export function createArtifactMcpServer(
  artifacts: ArtifactService,
  session: ArtifactMcpSession,
): McpServer {
  const server = new McpServer({ name: 'wake', version: '0.1.0' });
  server.registerTool(
    'wake_context_instructions_read',
    {
      description:
        'Read the trusted operator standing instructions captured for this run. Read-only; agent artifacts cannot replace them.',
    },
    async () => {
      await session.assertActive();
      const instructions = session.operatorInstructions;
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              instructions === undefined
                ? null
                : {
                    contextScope: instructions.contextScope,
                    revisionId: instructions.revisionId,
                    author: instructions.author,
                    occurredAt: instructions.occurredAt,
                    content: instructions.content,
                  },
            ),
          },
        ],
      };
    },
  );
  server.registerTool(
    'wake_artifacts_read',
    {
      description: 'Read a visible artifact revision as UTF-8 text or base64 bytes.',
      inputSchema: {
        revisionId: z.string().min(1),
        workItemId: z.string().min(1).optional(),
        encoding: z.enum(['utf8', 'base64']).default('utf8'),
        offset: z.number().int().nonnegative().default(0),
        length: z.number().int().positive().optional(),
      },
    },
    async ({ revisionId, workItemId, encoding, offset, length }) => {
      await session.assertActive();
      const artifact = await visibleArtifact(artifacts, session, revisionId, workItemId);
      if (artifact.location === undefined) throw new Error('Artifact revision has no content');
      const bytes = (await artifacts.read(artifact.location)).slice(
        offset,
        length === undefined ? undefined : offset + length,
      );
      return {
        content: [
          {
            type: 'text',
            text:
              encoding === 'base64'
                ? Buffer.from(bytes).toString('base64')
                : new TextDecoder('utf-8', { fatal: true }).decode(bytes),
          },
        ],
      };
    },
  );
  server.registerTool(
    'wake_artifacts_list',
    { description: 'List the current artifact manifest visible to this activation.' },
    async () => {
      await session.assertActive();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              (await visibleArtifacts(artifacts, session)).map(
                ({ location: _location, ...artifact }) => artifact,
              ),
            ),
          },
        ],
      };
    },
  );
  server.registerTool(
    'wake_artifacts_patch',
    {
      description:
        'Atomically replace one exact UTF-8 text fragment in an artifact owned by this producer.',
      inputSchema: {
        revisionId: z.string().min(1),
        find: z.string().min(1),
        replace: z.string(),
      },
    },
    async ({ revisionId, find, replace }) => {
      await session.assertActive();
      const artifact = await visibleArtifact(artifacts, session, revisionId);
      if (artifact.producer !== session.producer || artifact.workItemId !== session.workItemId)
        throw new Error('Only the owning producer may patch an artifact');
      if (artifact.location === undefined) throw new Error('Artifact revision has no content');
      const source = new TextDecoder('utf-8', { fatal: true }).decode(
        await artifacts.read(artifact.location),
      );
      const first = source.indexOf(find);
      if (first < 0 || source.indexOf(find, first + find.length) >= 0)
        throw new Error('Patch target must occur exactly once');
      const next = `${source.slice(0, first)}${replace}${source.slice(first + find.length)}`;
      const nextRevisionId = session.nextRevisionId();
      await artifacts.stageRevision(
        {
          revisionId: nextRevisionId,
          path: artifactPath(artifact.path),
          bytes: new TextEncoder().encode(next),
          ...(artifact.mediaType === undefined ? {} : { mediaType: artifact.mediaType }),
        },
        writeScope(session),
        session.commandContext(),
      );
      return { content: [{ type: 'text', text: JSON.stringify({ revisionId: nextRevisionId }) }] };
    },
  );
  server.registerTool(
    'wake_artifacts_write',
    {
      description: 'Stage UTF-8 content at a path owned by this activation producer.',
      inputSchema: {
        path: z.string().min(1),
        content: z.string(),
        encoding: z.enum(['utf8', 'base64']).default('utf8'),
        mediaType: z.string().min(1).optional(),
        share: z
          .boolean()
          .optional()
          .describe(
            "Select this revision for export to the run's trusted context after successful acceptance.",
          ),
      },
    },
    async ({ path, content, encoding, mediaType, share }) => {
      await session.assertActive();
      const revisionId = session.nextRevisionId();
      await artifacts.stageRevision(
        {
          revisionId,
          path: artifactPath(path),
          bytes: decodeContent(content, encoding),
          ...(share === undefined ? {} : { share }),
          ...(mediaType === undefined ? {} : { mediaType }),
        },
        writeScope(session),
        session.commandContext(),
      );
      return { content: [{ type: 'text', text: JSON.stringify({ revisionId }) }] };
    },
  );
  server.registerTool(
    'wake_artifacts_delete',
    {
      description: 'Stage deletion of an artifact path owned by this activation producer.',
      inputSchema: { path: z.string().min(1) },
    },
    async ({ path }) => {
      await session.assertActive();
      const revisionId = session.nextRevisionId();
      await artifacts.stageTombstone(
        {
          revisionId,
          path: artifactPath(path),
        },
        writeScope(session),
        session.commandContext(),
      );
      return { content: [{ type: 'text', text: JSON.stringify({ revisionId }) }] };
    },
  );
  return server;
}

async function visibleArtifact(
  artifacts: ArtifactService,
  session: ArtifactMcpSession,
  revisionId: string,
  workItemId?: string,
) {
  const matches = (await visibleArtifacts(artifacts, session)).filter(
    (candidate) =>
      candidate.revisionId === revisionId &&
      (workItemId === undefined || candidate.workItemId === workItemId),
  );
  if (matches.length > 1) throw new Error('Artifact revision is ambiguous; specify workItemId');
  const artifact = matches[0];
  if (artifact === undefined)
    throw new Error('Artifact revision is not visible to this activation');
  return artifact;
}

function visibleArtifacts(artifacts: ArtifactService, session: ArtifactMcpSession) {
  return artifacts.visibleTo(
    {
      workItemId: session.workItemId,
      producer: session.producer,
      runId: session.runId,
      activationId: session.activationId,
      readableProducers: session.readableProducers,
      ...(session.sharedReferences === undefined
        ? {}
        : { sharedReferences: session.sharedReferences }),
      ...(session.currentMemory === undefined ? {} : { currentMemory: session.currentMemory }),
    },
    session.acceptedActivation,
  );
}

function writeScope(session: ArtifactMcpSession) {
  return {
    workItemId: session.workItemId,
    producer: session.producer,
    runId: session.runId,
    activationId: session.activationId,
    ...(session.contextScope === undefined ? {} : { contextScope: session.contextScope }),
  };
}

function decodeContent(content: string, encoding: 'utf8' | 'base64'): Uint8Array {
  if (encoding === 'utf8') return new TextEncoder().encode(content);
  const bytes = Buffer.from(content, 'base64');
  if (bytes.toString('base64').replace(/=+$/, '') !== content.replace(/=+$/, ''))
    throw new Error('Artifact base64 content is invalid');
  return bytes;
}
