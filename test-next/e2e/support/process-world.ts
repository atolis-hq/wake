import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCompositionRoot,
  createSurfaceApplications,
  type CompositionRoot,
} from '../../../src-next/bootstrap/index.js';
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

  async readProjection<Value>(name: string) {
    if (this.root === undefined) throw new Error('ProcessWorld has not run');
    return this.root.projections.list<Value>(name);
  }

  async events() {
    if (this.root === undefined) throw new Error('ProcessWorld has not run');
    return this.root.journal.readAll(0);
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

  async dispose(): Promise<void> {
    await rm(this.wakeRoot, { recursive: true, force: true });
  }
}
