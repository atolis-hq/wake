import { InMemoryEventJournal } from '@atolis-hq/eventing/memory';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { RunRepository } from '../../../src/execution/index.js';
import { createDelegationOutputs } from '../../../src/integrations/index.js';
import {
  createDelegationReviewPolicy,
  OrchestrationRepository,
  WorkflowDefinitionRegistry,
} from '../../../src/orchestration/index.js';
import {
  ResourceCorrelationProvenance,
  ResourceCorrelationRole,
} from '../../../src/resources/index.js';

it('qualifies corum#142 from its pinned no-merge workflow and accepted review at the revised head', async () => {
  const journal = new InMemoryEventJournal({ now: () => new Date() });
  const facts = JSON.parse(
    await readFile(new URL('../../fixtures/delegation/corum-142.json', import.meta.url), 'utf8'),
  );
  for (const fact of facts) {
    const {
      stream,
      recordedAt: _recordedAt,
      sequence: _sequence,
      globalPosition: _position,
      ...event
    } = fact;
    await journal.appendToStream(stream, (await journal.readStream(stream)).length, [event]);
  }
  const repository = new OrchestrationRepository(journal);
  const child = (await repository.load('delegated:work-01m7hrcky7tr7rbwkkm39dx5kv')).view!;
  const runs = () => new RunRepository(journal).list();
  const reviewPolicy = createDelegationReviewPolicy(
    repository,
    new WorkflowDefinitionRegistry(journal, undefined, {}),
  );
  const policy = await reviewPolicy(child);
  expect(policy.requireApproval).toBe(false);
  const reviewed = (await runs()).find((run) => run.runId === 'run-01m7hscfmpethp5paefxx9d8mw')!;
  expect(reviewed.repositoryAssignment!.sourceRevision).toBe(
    '4daab3a4988dee6e444d28fe59c80bc0a0e0c439',
  );
  expect(reviewed.workspaceRevision).toBe('3e883082484cfe7c53fb43eaaa81803038d26f02');
  const service = createDelegationOutputs({
    artifacts: { qualifyingOutputs: async () => [] },
    reviewPolicy,
    runs,
    resources: {
      get: async () => ({ externalKey: { adapter: 'github', key: 'atolis-hq/corum' } }),
      findByExternalKey: async () => ({ resourceId: 'pr', kind: 'pull-request' }),
      primaryCorrelation: async () => ({
        workItemId: child.workItemId,
        role: ResourceCorrelationRole.Primary,
        provenance: ResourceCorrelationProvenance.AgentReported,
      }),
    },
    providers: async () => [
      {
        adapter: 'github',
        verifyArtifact: async () => ({
          externalKey: { adapter: 'github', key: 'atolis-hq/corum#142' },
          revision: reviewed.workspaceRevision,
        }),
      },
    ],
    pullRequests: {
      get: async () => ({ headRevision: reviewed.workspaceRevision, state: 'open' }),
      decideAuthority: async (
        _id: string,
        options: { requireAcceptedReview: boolean; requireChecks: boolean },
      ) => ({
        allowed: !options.requireAcceptedReview && options.requireChecks,
        revision: reviewed.workspaceRevision,
      }),
    },
  } as never);
  expect(
    await service.prerequisiteOutput!(child, { name: 'change', kind: 'change' }, 'delivery-ready'),
  ).toMatchObject({
    name: 'change',
    reference: { workItemId: child.workItemId, revision: reviewed.workspaceRevision },
  });
});
