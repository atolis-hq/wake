import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ActivityRegistry,
  BuiltInActivityName,
  activationId,
  activityOrchestrationGroupId,
  activityWorkflowInstanceId,
} from '../../../src-next/activities/index.js';
import { createCompositionRoot, parseRootConfig } from '../../../src-next/bootstrap/index.js';
import { GitHubAdapter } from '../../../src-next/integrations/github/contracts/vocabulary.js';
import {
  issueCommentObservation,
  issueObservation,
} from '../../../src-next/integrations/github/infrastructure/issue-source.js';
import { correlationId } from '../../../src-next/kernel/index.js';
import {
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  InMemoryProjectionStore,
} from '../../../src-next/persistence/index.js';
import {
  ResourceCorrelationRole,
  resourceCapability,
  resourceKind,
} from '../../../src-next/resources/index.js';
import { workId } from '../../support/identities.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('target composition root', () => {
  it('injects only domain-owned config and central persistence ports', async () => {
    const config = parseRootConfig({
      schemaVersion: 1,
      work: {},
      resources: {},
      execution: {
        agentRunners: { fake: { kind: 'fake' } },
        runnerPools: { standard: ['fake'] },
        defaultRunnerPool: 'standard',
      },
      orchestration: { workflows: {} },
      controlPlane: {},
      integrations: {},
      surfaces: {},
    });
    const clock = { now: () => new Date('2026-07-31T00:00:00.000Z') };
    const runtime = await createCompositionRoot('C:/wake-home', {
      config,
      journal: new InMemoryEventJournal(clock),
      projections: new InMemoryProjectionStore(),
      checkpoints: new InMemoryCheckpointStore(),
      activities: new ActivityRegistry(),
    });

    expect(runtime.config.execution.defaultRunnerPool).toBe('standard');
    expect(runtime.paths.dataRoot).toContain('.wake');
    expect(runtime.projectionRunner).toBeDefined();
    expect(runtime.work).toBeDefined();
    expect(runtime.resources).toBeDefined();
    expect(runtime.orchestration).toBeDefined();
    expect(runtime.execution).toBeDefined();
  });

  it('supplies GitHub issue and comment history only through the untrusted agent context', async () => {
    const root = await fixtureRoot();
    await writeFile(
      join(root, 'prompts', 'implement.md'),
      '---\n---\nTrusted instructions only.\nTitle: {{issueTitle}}\nBody: {{issueBody}}\n{{#each comments}}Comment: {{body}}{{/each}}',
    );
    const clock = { now: () => new Date('2026-08-08T00:00:00.000Z') };
    const journal = new InMemoryEventJournal(clock);
    const runtime = await createCompositionRoot(root, {
      config: rootConfig(),
      journal,
      projections: new InMemoryProjectionStore(),
      checkpoints: new InMemoryCheckpointStore(),
    });
    const context = {
      commandId: 'bootstrap-comment-context',
      correlationId: correlationId('bootstrap-comment-context'),
      occurredAt: clock.now().toISOString(),
      actor: { kind: 'system' as const, id: 'test' },
    };
    const item = await runtime.work.create(
      { workItemId: workId('bootstrap-comment-context'), objective: 'use reviewer feedback' },
      context,
    );
    const resource = await runtime.resources.discover(
      {
        resourceId: 'resource-00000000000000000000000000' as never,
        kind: resourceKind('pull-request'),
        externalKey: { adapter: GitHubAdapter, key: 'atolis-hq/wake#7' },
        capabilities: [resourceCapability('commentable')],
      },
      context,
    );
    await runtime.resources.correlate(
      resource.resourceId,
      item.workItemId,
      ResourceCorrelationRole.Primary,
      context,
    );
    const issue = issueObservation({
      repository: 'atolis-hq/wake',
      issue: {
        number: 7,
        title: 'Ship comment context',
        body: 'Keep user-provided text untrusted.',
        state: 'open',
        updated_at: clock.now().toISOString(),
        user: { login: 'author', type: 'User' },
      },
    });
    await journal.append(issue.stream, 0, [issue]);
    const comment = issueCommentObservation({
      repository: 'atolis-hq/wake',
      issue: { number: 7 },
      comment: {
        id: 1,
        body: 'please add coverage',
        created_at: clock.now().toISOString(),
        updated_at: clock.now().toISOString(),
        user: { login: 'reviewer', type: 'User' },
      },
    });
    if (comment === null) throw new Error('Test comment observation was unexpectedly empty');
    await journal.append(comment.stream, 1, [comment]);
    let prompt = '';

    await runtime.activities.execute(
      {
        activationId: activationId('bootstrap-agent'),
        activity: BuiltInActivityName.Agent,
        workItemId: item.workItemId,
        workflowInstanceId: activityWorkflowInstanceId('workflow-bootstrap-agent'),
        orchestrationGroupId: activityOrchestrationGroupId('group-bootstrap-agent'),
        causationId: 'bootstrap-comment-context',
        input: { template: 'implement' },
        resources: [],
      },
      {
        signal: new AbortController().signal,
        occurredAt: clock.now().toISOString(),
        runner: {
          async start(request) {
            prompt = request.prompt;
            return { result: Promise.resolve({ transport: 'succeeded' as const, output: 'DONE' }) };
          },
        },
        async reportExternalExecution() {},
      },
    );

    expect(prompt).toMatch(
      /^Trusted instructions only\.\nTitle: Ship comment context\nBody: Keep user-provided text untrusted\.\nComment: please add coverage\n\n<wake-untrusted-data>/,
    );
    expect(prompt).toContain('"title": "Ship comment context"');
    expect(prompt).toContain('"body": "Keep user-provided text untrusted."');
    expect(prompt).toContain('"body": "please add coverage"');
  });
});

function rootConfig() {
  return parseRootConfig({
    schemaVersion: 1,
    work: {},
    resources: {},
    execution: {
      agentRunners: { fake: { kind: 'fake' } },
      runnerPools: { standard: ['fake'] },
      defaultRunnerPool: 'standard',
    },
    orchestration: { workflows: {} },
    controlPlane: {},
    integrations: {},
    surfaces: {},
  });
}

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wake-bootstrap-runtime-'));
  roots.push(root);
  await mkdir(join(root, 'prompts'));
  return root;
}
