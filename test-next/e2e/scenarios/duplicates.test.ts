import { afterEach, expect } from 'vitest';
import { signalName } from '../../../src-next/orchestration/index.js';
import { ProcessWorld } from '../support/process-world.js';
import { defineScenario } from '../support/scenario.js';

const worlds: ProcessWorld[] = [];

afterEach(async () => {
  await Promise.all(worlds.splice(0).map((world) => world.dispose()));
});

defineScenario(
  {
    id: 'E2E-DUPLICATE-001',
    title: 'replays every duplicate fact without changing public state or effects',
    given: ['the production composition and deterministic fakes have accepted each fact once'],
    when: [
      'a Run outcome, delivery confirmation, child completion, provider event, and signal command are replayed exactly',
    ],
    then: ['the first public state and external effect remain the only ones'],
  },
  async () => {
    const intake = await ProcessWorld.create();
    const child = await ProcessWorld.create('wake-root-loop');
    worlds.push(intake, child);

    await intake.runTicksUntilIdle(4);
    const publicState = await publicStateOf(intake);
    const effects = await intake.deliveryEffects();
    await intake.repeatAcceptedRunOutcome();
    expect(await intake.retryConfirmedDelivery()).toBeNull();
    await intake.tick();
    expect(await publicStateOf(intake)).toEqual(publicState);
    expect(await intake.deliveryEffects()).toBe(effects);

    await child.tick();
    const childParentId = (await child.workflowInstances()).at(0)!.workflowInstanceId;
    await child.waitForSignal(childParentId, {
      signalKind: signalName('orchestration.child-completed'),
    });
    await child.publishEvidence([
      { key: 'loop#1', title: 'Implement with review', watchEvent: 'fake.review-requested' },
    ]);
    await child.runTicksUntilIdle();
    const childState = await publicStateOf(child);
    const childEffects = await child.deliveryEffects();
    await child.reconcileChildCompletions();
    await child.tick();
    expect(await publicStateOf(child)).toEqual(childState);
    expect(await child.deliveryEffects()).toBe(childEffects);

    const inbound = await ProcessWorld.create();
    worlds.push(inbound);
    await inbound.runTicksUntilIdle();
    const inboundState = await publicStateOf(inbound);
    const inboundEffects = await inbound.deliveryEffects();
    await inbound.pollProviderEvidence();
    await inbound.tick();
    expect(await publicStateOf(inbound)).toEqual(inboundState);
    expect(await inbound.deliveryEffects()).toBe(inboundEffects);

    const signal = await ProcessWorld.create('wake-root-lifecycle');
    worlds.push(signal);
    await signal.runTicksUntilIdle();
    const signalWorkflow = (await signal.workflowInstances()).at(0)!;
    const approved = {
      kind: signalName('approved'),
      actorId: 'operator',
      actorDecision: { authorized: true, evidenceId: 'duplicate-approved' },
      providerEventId: 'duplicate-approved',
    } as const;
    await signal.acceptSignal(signalWorkflow.workflowInstanceId, approved);
    await signal.runTicksUntilIdle();
    const signalState = await publicStateOf(signal);
    const signalEffects = await signal.providerEffects();
    await signal.acceptSignal(signalWorkflow.workflowInstanceId, approved);
    await signal.tick();
    expect(await publicStateOf(signal)).toEqual(signalState);
    expect(await signal.providerEffects()).toEqual(signalEffects);
  },
  30_000,
);

async function publicStateOf(world: ProcessWorld) {
  return {
    resources: await world.readProjection('resources'),
    work: await world.readProjection('work'),
    orchestration: await world.readProjection('orchestration'),
    delivery: await world.readProjection('delivery'),
  };
}
