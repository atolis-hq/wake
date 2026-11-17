import { InMemoryEventJournal } from '@atolis-hq/eventing/memory';
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { RunRepository } from '../../../src/execution/index.js';
import { matchesArtifactSource } from '../../../src/integrations/application/artifact-source.js';
import { createDelegationOutputs } from '../../../src/integrations/index.js';
import {
  createDelegationInputsReader,
  createDelegationReviewPolicy,
  OrchestrationRepository,
  WorkflowDefinitionRegistry,
} from '../../../src/orchestration/index.js';
import {
  BuiltInResourceKind,
  ResourceCorrelationProvenance,
  ResourceCorrelationRole,
} from '../../../src/resources/index.js';

// Real journal facts for corum#135: task 1 (#141) was stacked under task 2 (#142).
const taskOne = 'work-01m7hrcky7vrh233mh04h17hhc';
const taskTwo = 'work-01m7hrcky7tr7rbwkkm39dx5kv';
const repository = {
  resourceId: 'resource-01m7gssvh2myz9ggk7csb3ajj6',
  kind: BuiltInResourceKind.Repository,
  externalKey: { adapter: 'github', key: 'atolis-hq/corum' },
};
const prOne = {
  resourceId: 'resource-01m7hrnhsbwprtm1ej5v7ag4jm',
  kind: BuiltInResourceKind.PullRequest,
  externalKey: { adapter: 'github', key: 'atolis-hq/corum#141' },
};
const prTwo = {
  resourceId: 'resource-01m7hryg7cazt1pkwfd0g76djq',
  kind: BuiltInResourceKind.PullRequest,
  externalKey: { adapter: 'github', key: 'atolis-hq/corum#142' },
};
const attested = '3e883082484cfe7c53fb43eaaa81803038d26f02';
const mergedMain = 'a505194b5353590afc401e52ed26f7001151c894';

async function journalFromFixtures() {
  const journal = new InMemoryEventJournal({ now: () => new Date() });
  for (const name of ['corum-142.json', 'corum-135-retarget.json']) {
    const facts = JSON.parse(
      await readFile(new URL('../../fixtures/delegation/' + name, import.meta.url), 'utf8'),
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
  }
  return journal;
}

async function scenario(
  options: {
    readonly head?: string;
    readonly oneState?: 'open' | 'merged';
    readonly oneBase?: string;
    readonly twoBase?: string;
  } = {},
) {
  const head = options.head ?? mergedMain;
  const journal = await journalFromFixtures();
  const orchestration = new OrchestrationRepository(journal);
  const child = (await orchestration.load('delegated:' + taskTwo)).view!;
  // GitHub-shaped provider: identity is decided by the shared source matcher.
  const facts = {
    [prOne.externalKey.key]: {
      branch: taskOne,
      base: options.oneBase ?? 'main',
      revision: '4daab3a4988dee6e444d28fe59c80bc0a0e0c439',
    },
    [prTwo.externalKey.key]: { branch: taskTwo, base: options.twoBase ?? 'main', revision: head },
  };
  const verifyArtifact = vi.fn(async (kind, externalKey, context) => {
    const fact = facts[externalKey.key]!;
    return matchesArtifactSource(externalKey, { repository: 'atolis-hq/corum', ...fact }, context)
      ? { kind, externalKey, capabilities: [], revision: fact.revision }
      : 'not-found';
  });
  const service = createDelegationOutputs({
    artifacts: { qualifyingOutputs: async () => [] },
    reviewPolicy: createDelegationReviewPolicy(
      orchestration,
      new WorkflowDefinitionRegistry(journal, undefined, {}),
    ),
    inputs: createDelegationInputsReader(orchestration),
    runs: () => new RunRepository(journal).list(),
    resources: {
      get: async (id: string) =>
        [repository, prOne, prTwo].find((entry) => entry.resourceId === id) ?? null,
      findByExternalKey: async (key: { key: string }) =>
        [prOne, prTwo].find((entry) => entry.externalKey.key === key.key) ?? null,
      primaryCorrelation: async (id: string) => ({
        workItemId: id === prTwo.resourceId ? taskTwo : taskOne,
        role: ResourceCorrelationRole.Primary,
        provenance: ResourceCorrelationProvenance.AgentReported,
      }),
    },
    providers: async () => [
      {
        adapter: 'github',
        verifyArtifact,
        verifyRevisionAncestry: async (_repo: unknown, ancestor: string, descendant: string) =>
          ancestor === attested && descendant === mergedMain,
      },
    ],
    pullRequests: {
      get: async (id: string) =>
        id === prOne.resourceId
          ? {
              state: options.oneState ?? 'merged',
              headRevision: facts[prOne.externalKey.key]!.revision,
            }
          : { state: 'open', headRevision: head },
      decideAuthority: async () => ({ allowed: true, revision: head }),
    },
  } as never);
  return { service, child, verifyArtifact };
}

describe('corum#142 retargeted to main after its stacked upstream #141 merged', () => {
  it('accepts review recovery at the merged-main head through the journaled base lineage', async () => {
    const { service, child, verifyArtifact } = await scenario();
    expect(await service.reviewSubject!(child, { name: 'change', kind: 'change' })).toMatchObject({
      name: 'change',
      reference: {
        workItemId: taskTwo,
        resourceId: prTwo.resourceId,
        revision: mergedMain,
        branch: taskTwo,
        pullRequestBase: taskOne,
      },
    });
    // The recorded stacked base is tried first; the upstream PR's own base is provider-verified.
    expect(
      verifyArtifact.mock.calls.map(([, key, context]) => [key.key, context.pullRequestBase]),
    ).toEqual([
      ['atolis-hq/corum#142', taskOne],
      ['atolis-hq/corum#141', 'main'],
      ['atolis-hq/corum#142', 'main'],
    ]);
  });

  it('rejects the retargeted PR while the upstream PR is still open, naming the base check', async () => {
    const { service, child } = await scenario({ oneState: 'open' });
    await expect(service.reviewSubject!(child, { name: 'change', kind: 'change' })).rejects.toThrow(
      'Child PR identity mismatch: provider did not confirm atolis-hq/corum#142 in atolis-hq/corum on branch ' +
        taskTwo +
        ' at head ' +
        mergedMain +
        ' targeting ' +
        taskOne +
        ' (no merged upstream base lineage)',
    );
  });

  it('rejects when the merged upstream PR did not target the PR base now observed', async () => {
    const { service, child } = await scenario({ oneBase: 'release' });
    await expect(service.reviewSubject!(child, { name: 'change', kind: 'change' })).rejects.toThrow(
      'targeting ' + taskOne + ' (no merged upstream base lineage)',
    );
  });

  it('rejects a base that is neither recorded nor the merged upstream base', async () => {
    const { service, child } = await scenario({ twoBase: 'release' });
    await expect(service.reviewSubject!(child, { name: 'change', kind: 'change' })).rejects.toThrow(
      'targeting ' + taskOne + ' or main',
    );
  });

  it('keeps the pre-retarget review from qualifying the retargeted PR without review recovery', async () => {
    const { service, child, verifyArtifact } = await scenario({ head: attested });
    const reasons: string[] = [];
    expect(
      await service.prerequisiteOutput!(
        child,
        { name: 'change', kind: 'change' },
        'delivery-ready',
        (reason) => reasons.push(reason),
      ),
    ).toBeNull();
    expect(reasons).toEqual([
      'Child PR identity mismatch: provider did not confirm atolis-hq/corum#142 in atolis-hq/corum on branch ' +
        taskTwo +
        ' at head ' +
        attested +
        ' targeting ' +
        taskOne +
        ' (a retargeted stack needs review recovery at its current head)',
    ]);
    // The upstream lineage is not consulted for an unrecovered subject.
    expect(verifyArtifact).toHaveBeenCalledTimes(1);
  });
});
