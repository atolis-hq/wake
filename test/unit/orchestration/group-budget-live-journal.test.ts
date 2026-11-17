import { correlationId, type CommandContext } from '@atolis-hq/eventing';
import { InMemoryEventJournal } from '@atolis-hq/eventing/memory';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import {
  ApprovalAuthorityKind,
  ConversationSurfaceCapability,
  createOrchestrationService,
  GroupBudgetExtensionIneligibleError,
  isGroupBudgetExtensionEligible,
  OrchestrationRepository,
  workflowInstanceId,
  WorkflowStatus,
  type CompiledWorkflow,
} from '../../../src/orchestration/index.js';
import { createWorkService, workItemId } from '../../../src/work/index.js';

/**
 * Trimmed journal of corum#135 task 2 (`delegated:work-01m7hrcky7tr7rbwkkm39dx5kv`), as recorded
 * before the operator could extend it: three real pr-review verdicts, two fresh-review attempts
 * the runner never answered (a transport failure, then an expired login), and attempt 3's request
 * that found `pr-review`'s `maxPerGroup: 5` spent. The delegated instance completed long before.
 */
const task2 = workflowInstanceId('delegated:work-01m7hrcky7tr7rbwkkm39dx5kv');
const attempt3 = /review-refresh:change:a505194b5353590afc401e52ed26f7001151c894:attempt:3$/;

type Fact = {
  readonly eventType: string;
  readonly stream: { readonly kind: string; readonly id: string };
  readonly payload: Record<string, unknown> & {
    readonly outcome?: { kind: string; data: unknown };
  };
  readonly [key: string]: unknown;
};

const context = (commandId: string): CommandContext => ({
  commandId,
  correlationId: correlationId('budget-live'),
  occurredAt: '2026-11-17T19:30:00.000Z',
  actor: { kind: 'operator', id: 'operator' },
});

async function facts(): Promise<Fact[]> {
  return JSON.parse(
    await readFile(
      new URL('../../fixtures/delegation/corum-142-review-budget.json', import.meta.url),
      'utf8',
    ),
  );
}

async function replay(entries: readonly Fact[]) {
  const journal = new InMemoryEventJournal({ now: () => new Date('2026-11-17T19:30:00.000Z') });
  for (const fact of entries) {
    const {
      stream,
      sequence: _sequence,
      globalPosition: _position,
      recordedAt: _recorded,
      ...event
    } = fact as Fact & { sequence?: number; globalPosition?: number; recordedAt?: string };
    await journal.appendToStream(
      stream as never,
      (await journal.readStream(stream as never)).length,
      [event as never],
    );
  }
  const work = createWorkService(journal);
  await work.create(
    { workItemId: workItemId('work-01m7hrcky7tr7rbwkkm39dx5kv'), objective: 'namespace-137' },
    context('create-task-2'),
  );
  const definitions = Object.fromEntries(
    entries.flatMap((fact) =>
      fact.eventType === 'orchestration.workflow-definition-registered'
        ? [
            [
              fact.payload.workflowName as string,
              fact.payload.compiledDefinition as CompiledWorkflow,
            ],
          ]
        : [],
    ),
  );
  return {
    journal,
    repository: new OrchestrationRepository(journal),
    service: createOrchestrationService(journal, work, definitions),
  };
}

const exhaustionIndex = (entries: readonly Fact[]) =>
  entries.findIndex((fact) => fact.eventType === 'orchestration.group-budget-exhausted');

/** The journal as it stood when attempt 3 was requested: before the budget was found spent. */
async function beforeExhaustion(transform: (fact: Fact) => Fact = (fact) => fact) {
  const all = await facts();
  return all.slice(0, exhaustionIndex(all)).map(transform);
}

const withoutVerdict = (reason: string) => (fact: Fact) =>
  fact.eventType === 'orchestration.activity-outcome-accepted' &&
  /attempt:2|review-refresh:change:a505194b5353590afc401e52ed26f7001151c894:activity/.test(
    String(fact.payload.activationId),
  ) &&
  fact.payload.outcome?.kind !== 'done'
    ? { ...fact, payload: { ...fact.payload, outcome: { kind: 'failed', data: { reason } } } }
    : fact;

it('starts the next fresh review when earlier attempts ended without a verdict because the runner failed', async () => {
  const { journal, repository, service } = await replay(await beforeExhaustion());
  const parent = (await repository.load(task2)).view!;
  expect(parent.status).toBe(WorkflowStatus.Completed);

  await service.reconcileChildCompletions(context('reconcile'));

  const events = (await journal.readAll(0)).map(({ event }) => event);
  expect(
    events.filter((event) => event.eventType === 'orchestration.group-budget-exhausted'),
  ).toEqual([]);
  const started = (await service.listAll()).filter(
    (workflow) =>
      workflow.parentWorkflowInstanceId === task2 && attempt3.test(workflow.workflowInstanceId),
  );
  expect(started).toHaveLength(1);
  expect((await repository.load(task2)).view!.status).toBe(WorkflowStatus.Completed);
});

it('still spends the budget on attempts that failed for reasons other than the runner', async () => {
  const { service, repository } = await replay(
    await beforeExhaustion(withoutVerdict('invalid-agent-result')),
  );

  await service.reconcileChildCompletions(context('reconcile'));

  const parent = (await repository.load(task2)).view!;
  expect(parent.status).toBe(WorkflowStatus.Blocked);
  expect(parent.blockReason).toBe('watch group budget exhausted for pr-review');
});

it('extends a completed delegated child blocked on the review budget and starts the fresh review', async () => {
  const { journal, repository, service } = await replay(await facts());
  const blocked = (await repository.load(task2)).view!;
  // The live shape: parentless, blocked on exhaustion, and no gate wait left to restore.
  expect(blocked.status).toBe(WorkflowStatus.Blocked);
  expect(blocked.parentWorkflowInstanceId).toBeUndefined();
  expect(blocked.waitingFor).toBeUndefined();
  expect(isGroupBudgetExtensionEligible(blocked)).toBe(true);

  await service.extendBlockedGroupBudget(
    task2,
    { kind: ApprovalAuthorityKind.Human },
    context('operator-extend'),
  );

  const events = (await journal.readAll(0)).map(({ event }) => event);
  expect(
    events.filter((event) => event.eventType === 'orchestration.group-budget-granted'),
  ).toHaveLength(1);
  const parent = (await repository.load(task2)).view!;
  expect(parent.status).toBe(WorkflowStatus.Completed);
  const review = (await service.listAll()).find(
    (workflow) =>
      workflow.parentWorkflowInstanceId === task2 && attempt3.test(workflow.workflowInstanceId),
  );
  expect(review?.pendingActivation?.status).toBe('pending');
  expect(isGroupBudgetExtensionEligible(parent)).toBe(false);
});

it('refuses to extend without human authority or a pending review recovery, granting nothing', async () => {
  const all = await facts();
  const noPendingRequest = all.filter(
    (fact) =>
      !(
        fact.eventType === 'orchestration.delegation-review-refresh-requested' &&
        attempt3.test(String(fact.payload.requestId))
      ),
  );
  const { journal, service } = await replay(noPendingRequest);

  await expect(
    service.extendBlockedGroupBudget(
      task2,
      { kind: ApprovalAuthorityKind.Watch },
      context('automated'),
    ),
  ).rejects.toThrow('requires human authority');
  await expect(
    service.extendBlockedGroupBudget(
      task2,
      { kind: ApprovalAuthorityKind.Human },
      context('operator-extend'),
    ),
  ).rejects.toThrow(GroupBudgetExtensionIneligibleError);

  expect(
    (await journal.readAll(0)).filter(
      ({ event }) => event.eventType === 'orchestration.group-budget-granted',
    ),
  ).toEqual([]);
});

const task2Work = workItemId('work-01m7hrcky7tr7rbwkkm39dx5kv');
const slashExtend = {
  body: '/extend',
  actorId: 'operator',
  capabilities: [ConversationSurfaceCapability.Operator],
  authorized: true,
};

it('applies a conversation /extend to the completed delegated child and names why it cannot otherwise', async () => {
  const live = await replay(await facts());
  await expect(
    live.service.applyConversationCommandWithFeedback(
      task2Work,
      slashExtend,
      context('chat-extend'),
    ),
  ).resolves.toEqual({ applied: true });
  expect((await live.repository.load(task2)).view!.status).toBe(WorkflowStatus.Completed);

  const all = await facts();
  const noPendingRequest = await replay(
    all.filter(
      (fact) =>
        !(
          fact.eventType === 'orchestration.delegation-review-refresh-requested' &&
          attempt3.test(String(fact.payload.requestId))
        ),
    ),
  );
  await expect(
    noPendingRequest.service.applyConversationCommandWithFeedback(
      task2Work,
      slashExtend,
      context('chat-extend-none'),
    ),
  ).resolves.toMatchObject({
    applied: false,
    reason: expect.stringContaining('pending review recovery'),
  });
});
