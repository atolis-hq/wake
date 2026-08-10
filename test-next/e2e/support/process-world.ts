import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCompositionRoot,
  createSurfaceApplications,
  type CompositionRoot,
} from '../../../src-next/bootstrap/index.js';
import { RunStatus } from '../../../src-next/execution/index.js';
import { main } from '../../../src-next/main.js';
import {
  workflowInstanceId as parseWorkflowInstanceId,
  type OrchestrationSignal,
} from '../../../src-next/orchestration/index.js';

export class ProcessWorld {
  private root: CompositionRoot | undefined;

  private constructor(readonly wakeRoot: string) {}

  static async create(fixture = 'wake-root'): Promise<ProcessWorld> {
    const wakeRoot = await mkdtemp(join(tmpdir(), 'wake-process-'));
    await cp(join('test-next/e2e/fixtures', fixture), wakeRoot, { recursive: true });
    return new ProcessWorld(wakeRoot);
  }

  async tick(): Promise<void> {
    await main(['tick', '--wake-root', this.wakeRoot], {
      compose: async (wakeRoot) => {
        this.root = await createCompositionRoot(wakeRoot);
        return createSurfaceApplications(this.root).cli;
      },
      output: { write() {} },
      signal: new AbortController().signal,
    });
  }

  async publishEvidence(
    evidence: readonly {
      readonly key: string;
      readonly title: string;
      readonly kind?: 'issue' | 'pull-request';
      readonly revision?: string;
      readonly baseRevision?: string;
      readonly checks?: 'unknown' | 'pending' | 'passing' | 'failing';
      readonly acceptedReview?: boolean;
      readonly reviewActorId?: string;
      readonly reviewActorKind?: 'human' | 'bot';
      readonly reviewerId?: string;
      readonly branch?: string;
      readonly changedFiles?: readonly string[];
      readonly watchEvent?: string;
      readonly eligible?: boolean;
    }[],
  ): Promise<void> {
    await writeFile(
      join(this.wakeRoot, 'provider', 'evidence.json'),
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
  }

  async runTicksUntilIdle(limit = 10): Promise<void> {
    for (let index = 0; index < limit; index += 1) await this.tick();
  }

  async pollProviderEvidence(): Promise<void> {
    if (this.root === undefined) throw new Error('ProcessWorld has not run');
    await this.root.intakePipeline.run(new AbortController().signal);
  }

  async readProjection<Value>(name: string) {
    if (this.root === undefined) throw new Error('ProcessWorld has not run');
    return this.root.projections.list<Value>(name);
  }

  async events() {
    if (this.root === undefined) throw new Error('ProcessWorld has not run');
    return this.root.journal.readAll(0);
  }

  async workflowInstances() {
    if (this.root === undefined) throw new Error('ProcessWorld has not run');
    return this.root.orchestration.listAll();
  }

  async repeatAcceptedRunOutcome(): Promise<void> {
    if (this.root === undefined) throw new Error('ProcessWorld has not run');
    for (const workflow of await this.root.orchestration.listAll()) {
      for (const activationId of workflow.acceptedOutcomes) {
        const run = (await this.root.execution.list(activationId)).find(
          (candidate) =>
            candidate.status === RunStatus.Succeeded && candidate.outcome !== undefined,
        );
        if (run === undefined || run.outcome === undefined) continue;
        await this.root.orchestration.acceptOutcome(
          { workflowInstanceId: workflow.workflowInstanceId, activationId, outcome: run.outcome },
          {
            commandId: `process-world-repeat-run-outcome:${run.runId}`,
            correlationId: 'process-world-duplicate' as never,
            occurredAt: new Date().toISOString(),
            actor: { kind: 'operator', id: 'owner' },
          },
        );
        return;
      }
    }
    throw new Error('No accepted Run outcome is available to repeat');
  }

  async retryConfirmedDelivery() {
    if (this.root === undefined) throw new Error('ProcessWorld has not run');
    return this.root.delivery.deliverNext(new AbortController().signal);
  }

  async reconcileChildCompletions(): Promise<void> {
    if (this.root === undefined) throw new Error('ProcessWorld has not run');
    await this.root.orchestration.reconcileChildCompletions({
      commandId: 'process-world-repeat-child-completion',
      correlationId: 'process-world-duplicate' as never,
      occurredAt: new Date().toISOString(),
      actor: { kind: 'operator', id: 'owner' },
    });
  }

  async deliveryEffects(): Promise<string> {
    return readFile(join(this.wakeRoot, 'provider', 'effects.json'), 'utf8');
  }

  async providerEffects(): Promise<Record<string, string>> {
    if (this.root === undefined) throw new Error('ProcessWorld has not run');
    const provider = this.root.providers.find((candidate) => candidate.adapter === 'fake');
    if (provider === undefined || !('effects' in provider.delivery))
      throw new Error('Fake provider delivery effects are unavailable');
    const effects = provider.delivery.effects;
    if (!(effects instanceof Map)) throw new Error('Fake provider delivery effects are invalid');
    return Object.fromEntries(effects);
  }

  async acceptSignal(workflowInstanceId: string, signal: OrchestrationSignal): Promise<void> {
    if (this.root === undefined) throw new Error('ProcessWorld has not run');
    await this.root.orchestration.acceptSignal(
      parseWorkflowInstanceId(workflowInstanceId),
      signal,
      {
        commandId: `${signal.providerEventId}:accept`,
        correlationId: 'process-world-signal' as never,
        occurredAt: new Date().toISOString(),
        actor: { kind: 'operator', id: 'owner' },
      },
    );
  }

  async waitForSignal(
    workflowInstanceId: string,
    expectation: Parameters<CompositionRoot['orchestration']['waitForSignal']>[1],
  ): Promise<void> {
    if (this.root === undefined) throw new Error('ProcessWorld has not run');
    await this.root.orchestration.waitForSignal(
      parseWorkflowInstanceId(workflowInstanceId),
      expectation,
      {
        commandId: `process-world-wait:${workflowInstanceId}`,
        correlationId: 'process-world-signal' as never,
        occurredAt: new Date().toISOString(),
        actor: { kind: 'operator', id: 'owner' },
      },
    );
  }

  async dispose(): Promise<void> {
    await rm(this.wakeRoot, { recursive: true, force: true });
  }
}
