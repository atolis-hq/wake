import type { CommandContext } from '@atolis-hq/eventing';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WorkItemId } from '../../work/index.js';
import type { ArtifactService } from '../application/artifact-service.js';
import { artifactPath } from '../contracts/paths.js';

/** A capability token is resolved into this server-side scope by Execution. */
export interface ArtifactMcpSession {
  readonly workItemId: WorkItemId;
  readonly producer: string;
  readonly runId: string;
  readonly activationId: string;
  readonly readableProducers: ReadonlySet<string>;
  readonly nextRevisionId: () => string;
  readonly commandContext: () => CommandContext;
  readonly acceptedActivation: (activationId: string) => Promise<boolean>;
}

export function createArtifactMcpServer(
  artifacts: ArtifactService,
  session: ArtifactMcpSession,
): McpServer {
  const server = new McpServer({ name: 'wake', version: '0.1.0' });
  server.registerTool(
    'wake.artifacts.read',
    {
      description: 'Read a visible artifact revision as UTF-8 text or base64 bytes.',
      inputSchema: {
        revisionId: z.string().min(1),
        encoding: z.enum(['utf8', 'base64']).default('utf8'),
      },
    },
    async ({ revisionId, encoding }) => {
      const artifact = await visibleArtifact(artifacts, session, revisionId);
      if (artifact.location === undefined) throw new Error('Artifact revision has no content');
      const bytes = await artifacts.read(artifact.location);
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
    'wake.artifacts.list',
    { description: 'List the current artifact manifest visible to this activation.' },
    async () => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            (await artifacts.latestPublished(session.workItemId, session.acceptedActivation))
              .filter((artifact) => session.readableProducers.has(artifact.producer))
              .map(({ location: _location, ...artifact }) => artifact),
          ),
        },
      ],
    }),
  );
  server.registerTool(
    'wake.artifacts.patch',
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
      const artifact = await visibleArtifact(artifacts, session, revisionId);
      if (artifact.producer !== session.producer)
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
          workItemId: session.workItemId,
          revisionId: nextRevisionId,
          producer: session.producer,
          path: artifactPath(artifact.path),
          runId: session.runId,
          activationId: session.activationId,
          bytes: new TextEncoder().encode(next),
          ...(artifact.mediaType === undefined ? {} : { mediaType: artifact.mediaType }),
        },
        session.commandContext(),
      );
      return { content: [{ type: 'text', text: JSON.stringify({ revisionId: nextRevisionId }) }] };
    },
  );
  server.registerTool(
    'wake.artifacts.write',
    {
      description: 'Stage UTF-8 content at a path owned by this activation producer.',
      inputSchema: {
        path: z.string().min(1),
        text: z.string(),
        mediaType: z.string().min(1).optional(),
      },
    },
    async ({ path, text, mediaType }) => {
      const revisionId = session.nextRevisionId();
      await artifacts.stageRevision(
        {
          workItemId: session.workItemId,
          revisionId,
          producer: session.producer,
          path: artifactPath(path),
          runId: session.runId,
          activationId: session.activationId,
          bytes: new TextEncoder().encode(text),
          ...(mediaType === undefined ? {} : { mediaType }),
        },
        session.commandContext(),
      );
      return { content: [{ type: 'text', text: JSON.stringify({ revisionId }) }] };
    },
  );
  server.registerTool(
    'wake.artifacts.delete',
    {
      description: 'Stage deletion of an artifact path owned by this activation producer.',
      inputSchema: { path: z.string().min(1) },
    },
    async ({ path }) => {
      const revisionId = session.nextRevisionId();
      await artifacts.stageTombstone(
        {
          workItemId: session.workItemId,
          revisionId,
          producer: session.producer,
          path: artifactPath(path),
          runId: session.runId,
          activationId: session.activationId,
        },
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
) {
  const artifact = (
    await artifacts.latestPublished(session.workItemId, session.acceptedActivation)
  ).find(
    (candidate) =>
      candidate.revisionId === revisionId && session.readableProducers.has(candidate.producer),
  );
  if (artifact === undefined)
    throw new Error('Artifact revision is not visible to this activation');
  return artifact;
}
