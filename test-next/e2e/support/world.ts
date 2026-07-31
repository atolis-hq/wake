import {
  createEventDraft,
  correlationId,
  type Clock,
  type EntityRef,
  type EventEnvelope,
  type IdGenerator,
} from '../../../src-next/kernel/index.js';
import {
  InMemoryCheckpointStore,
  InMemoryEventJournal,
} from '../../../src-next/persistence/index.js';
import {
  ActivityRegistry,
  activationId as parseActivationId,
  createPullRequestService,
  type ActivityDefinition,
} from '../../../src-next/activities/index.js';
import { createWorkService, workItemId, type WorkItemId } from '../../../src-next/work/index.js';
import { createResourceService, type ResourceView } from '../../../src-next/resources/index.js';
import {
  compileWorkflow,
  createOrchestrationService,
  createWatchReactor,
  orchestrationGroupId,
  workflowInstanceId as parseWorkflowInstanceId,
  workflowName,
  type CompiledWorkflow,
  type WorkflowDefinitionConfig,
  type WorkflowInstanceView,
} from '../../../src-next/orchestration/index.js';
import { createExecutionService, type RunView } from '../../../src-next/execution/index.js';
import { createAdvanceOnce, type AdvanceResult } from '../../../src-next/control-plane/index.js';
import { FaultInjector } from './faults.js';
import { formatTrace } from './trace.js';

export class FakeClock implements Clock {
  private current = new Date('2026-07-30T12:00:00.000Z');

  now(): Date {
    return new Date(this.current);
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

export class SequentialIds implements IdGenerator {
  private nextValue = 1;

  next(prefix: string): string {
    return `${prefix}-${this.nextValue++}`;
  }
}

export class TestWorld {
  readonly clock = new FakeClock();
  readonly ids = new SequentialIds();
  readonly faults = new FaultInjector();
  readonly journal = new InMemoryEventJournal(this.clock);
  readonly checkpoints = new InMemoryCheckpointStore();
  readonly activities = new ActivityRegistry();
  private readonly definitions: Record<string, CompiledWorkflow> = {};
  readonly work = createWorkService(this.journal);
  readonly resources = createResourceService(this.journal);
  readonly pullRequests = createPullRequestService(this.journal, this.work, this.resources);
  private readonly orchestration = createOrchestrationService(
    this.journal,
    this.work,
    this.definitions,
  );
  private readonly execution = createExecutionService(
    this.journal,
    this.activities,
    { tiers: { standard: ['fake'] }, defaultTier: 'standard' },
    { clock: this.clock, ids: this.ids },
  );
  private readonly advanceOnce = createAdvanceOnce(
    this.orchestration,
    this.execution,
    this.resources,
    this.clock,
    this.ids,
  );
  private readonly watchReactor = createWatchReactor(
    this.orchestration,
    this.journal,
    this.checkpoints,
  );
  private readonly stream: EntityRef<'test', 'scenario'> = {
    kind: 'test',
    id: 'scenario',
  };

  async appendFact<Type extends string, Payload>(
    eventType: Type,
    payload: Payload,
    cause: string,
  ): Promise<EventEnvelope<Type, Payload>> {
    const currentEvents = await this.journal.readStream(this.stream);
    const [appended] = await this.journal.append(this.stream, currentEvents.length, [
      createEventDraft({
        eventId: this.ids.next('event'),
        eventType,
        occurredAt: this.clock.now().toISOString(),
        correlationId: 'scenario-1',
        causationId: cause,
        actor: { kind: 'system', id: 'test' },
        source: { kind: 'internal', id: 'test' },
        stream: this.stream,
        payload,
      }),
    ]);
    if (appended === undefined) throw new Error('Scenario fact was not appended');
    return appended as EventEnvelope<Type, Payload>;
  }

  async trace(): Promise<string> {
    return formatTrace(await this.journal.readAll(0));
  }

  registerActivity(definition: ActivityDefinition): void {
    this.activities.register(definition);
  }
  configureWorkflow(name: string, config: WorkflowDefinitionConfig): CompiledWorkflow {
    const compiled = compileWorkflow(name, config, this.activities, [
      ...Object.keys(this.definitions),
      name,
    ]);
    this.definitions[name] = compiled;
    return compiled;
  }
  async createWork(input: { objective: string; workItemId?: WorkItemId }) {
    const id = input.workItemId ?? workItemId(this.ids.next('work'));
    return this.work.create({ workItemId: id, objective: input.objective }, this.command());
  }
  async discoverResource(
    input: Parameters<typeof this.resources.discover>[0],
  ): Promise<ResourceView> {
    return this.resources.discover(input, this.command());
  }
  async startWorkflow(input: {
    workItemId: WorkItemId;
    workflowName: string;
    workflowInstanceId?: string;
    orchestrationGroupId?: string;
  }): Promise<WorkflowInstanceView> {
    const id = input.workflowInstanceId ?? this.ids.next('workflow');
    return this.orchestration.start(
      {
        workflowInstanceId: parseWorkflowInstanceId(id),
        workItemId: input.workItemId,
        workflowName: workflowName(input.workflowName),
        orchestrationGroupId: orchestrationGroupId(input.orchestrationGroupId ?? id),
      },
      this.command(),
    );
  }
  waitForSignal(
    workflowInstanceId: string,
    expectation: Parameters<typeof this.orchestration.waitForSignal>[1],
  ) {
    return this.orchestration.waitForSignal(
      parseWorkflowInstanceId(workflowInstanceId),
      expectation,
      this.command({ kind: 'operator', id: 'owner' }),
    );
  }
  acceptSignal(
    workflowInstanceId: string,
    signal: Parameters<typeof this.orchestration.acceptSignal>[1],
  ) {
    return this.orchestration.acceptSignal(
      parseWorkflowInstanceId(workflowInstanceId),
      signal,
      this.command({ kind: 'operator', id: 'owner' }),
    );
  }
  acceptOutcome(
    workflowInstanceId: string,
    activationId: string,
    outcome: Parameters<typeof this.orchestration.acceptOutcome>[0]['outcome'],
  ) {
    return this.orchestration.acceptOutcome(
      {
        workflowInstanceId: parseWorkflowInstanceId(workflowInstanceId),
        activationId: parseActivationId(activationId),
        outcome,
      },
      this.command({ kind: 'integration', id: 'synthetic-delivery' }),
    );
  }
  requestSupplementalActivity(
    workflowInstanceId: string,
    request: Parameters<typeof this.orchestration.requestSupplementalActivity>[1],
  ) {
    return this.orchestration.requestSupplementalActivity(
      parseWorkflowInstanceId(workflowInstanceId),
      request,
      this.command({ kind: 'operator', id: 'owner' }),
    );
  }
  async advance(workItemId?: WorkItemId): Promise<AdvanceResult> {
    const result = await this.advanceOnce({
      ...(workItemId === undefined ? {} : { workItemId }),
      maxProgress: 1,
    });
    await this.watchReactor.runOnce();
    return result;
  }
  async triggerWatch(
    eventType: string,
    eventId: string,
    payload: unknown = {},
    stream: EntityRef = this.stream,
  ): Promise<void> {
    const events = await this.journal.readStream(stream);
    const [event] = await this.journal.append(stream, events.length, [
      createEventDraft({
        eventId,
        eventType,
        occurredAt: this.clock.now().toISOString(),
        correlationId: 'scenario-1',
        causationId: eventId,
        actor: { kind: 'integration', id: 'test' },
        source: { kind: 'internal', id: 'test' },
        stream,
        payload,
      }),
    ]);
    if (event === undefined) throw new Error('Watch trigger was not appended');
    await this.watchReactor.runOnce();
  }
  async events(type?: string): Promise<readonly EventEnvelope[]> {
    const events = await this.journal.readAll(0);
    return type === undefined ? events : events.filter((event) => event.eventType === type);
  }
  viewWork(id: WorkItemId) {
    return this.work.get(id);
  }
  viewWorkflow(id: string) {
    return this.orchestration.get(parseWorkflowInstanceId(id));
  }
  viewRuns(activationId?: string): Promise<readonly RunView[]> {
    return this.execution.list(activationId);
  }
  private command(
    actor: { kind: 'system' | 'operator' | 'agent' | 'integration'; id: string } = {
      kind: 'system',
      id: 'test-world',
    },
  ) {
    const commandId = this.ids.next('command');
    return {
      commandId,
      correlationId: correlationId('scenario-1'),
      occurredAt: this.clock.now().toISOString(),
      actor,
    };
  }
}
