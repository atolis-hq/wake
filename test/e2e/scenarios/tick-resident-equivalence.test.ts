import { expect, it } from 'vitest';
import { composeControlPlaneHosts } from '../../../src/bootstrap/index.js';
import {
  createOneShotRunnerAdvance,
  createResidentRunnerAdvance,
} from '../../../src/bootstrap/runner-tick-adapter.js';
import { ResidentHost, TickHost } from '../../../src/control-plane/index.js';

const scenario = { id: 'E2E-CONTROL-002' } as const;

it(`${scenario.id}: TickHost and ResidentHost share bounded advancement`, async () => {
  const calls: number[] = [];
  const controller = new AbortController();
  const runtime = composeControlPlaneHosts(async () => {
    calls.push(calls.length);
    if (calls.length === 2) controller.abort();
    return { kind: 'no-work' as const };
  });
  const budget = { maxAdvances: 1, maxRuns: 1, maxDurationMs: 1000 };
  await expect(runtime.tick.run(budget)).resolves.toMatchObject({ stoppedBecause: 'idle' });
  await expect(runtime.resident.run(controller.signal, budget)).resolves.toMatchObject({
    stoppedBecause: 'shutdown',
  });
  expect(calls).toHaveLength(2);
});

it('E2E-CONTROL-006: inline rollback and subscriber migration keep tick and resident scheduling distinct', async () => {
  const budget = { maxAdvances: 1, maxRuns: 1, maxDurationMs: 1000 };
  const trace: string[] = [];

  for (const mode of ['inline', 'subscriber'] as const) {
    const controller = new AbortController();
    let pipelineCalls = 0;
    const runnerPipeline = {
      async run() {
        pipelineCalls += 1;
        trace.push(`${mode}:pipeline:${pipelineCalls}`);
        if (pipelineCalls === 2) controller.abort();
        return { kind: 'no-work' as const };
      },
    };
    const subscriber = {
      async poke() {
        trace.push(`${mode}:subscriber-poke`);
        return { kind: 'no-work' as const };
      },
    };
    const root = {
      runnerPipeline,
      ...(mode === 'subscriber' ? { activationSchedulerSubscriber: subscriber } : {}),
    };
    const tick = new TickHost(createOneShotRunnerAdvance(root));
    const resident = new ResidentHost(new TickHost(createResidentRunnerAdvance(root)));

    await tick.run(budget);
    await resident.run(controller.signal, budget);
  }

  expect(trace).toEqual([
    'inline:pipeline:1',
    'inline:pipeline:2',
    'subscriber:pipeline:1',
    'subscriber:subscriber-poke',
    'subscriber:pipeline:2',
  ]);
});
