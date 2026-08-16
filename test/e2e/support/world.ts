import {
  ActivityRegistry,
  createPullRequestService,
  activationId as parseActivationId,
  type ActivityDefinition,
} from '../../../src/activities/index.js';
import { createCapabilityResourceTransitionEvidence } from '../../../src/bootstrap/index.js';
import {
  createAdvanceOnce,
  createWorkCancellationPolicy,
  type AdvanceResult,
} from '../../../src/control-plane/index.js';
import {
  createExecutionService,
  createRecoveryCoordinator,
  ExecutionCancellationReason,
  RecoveryService,
  RunRepository,
  type ExternalExecutionInspector,
  type RunView,
} from '../../../src/execution/index.js';
import {
  correlationId,
  createEventDraft,
  type Clock,
  type EntityRef,
  type EventEnvelope,
  type IdGenerator,
} from '../../../src/kernel/index.js';
import {
  compileWorkflow,
  createOrchestrationService,
  createPullRequestTransitionEvidence,
  createResourceTransitionReactor,
  createWatchReactor,
  orchestrationGroupId,
  workflowInstanceId as parseWorkflowInstanceId,
  workflowDefinitionsProjection,
  workflowName,
  type CompiledWorkflow,
  type WorkflowDefinitionConfig,
  type WorkflowInstanceView,
} from '../../../src/orchestration/index.js';
import {
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  InMemoryProjectionStore,
  ProjectionRunner,
} from '../../../src/persistence/index.js';
import {
  BuiltInResourceCapability,
  createResourceLookup,
  createResourceService,
  type ResourceView,
} from '../../../src/resources/index.js';
import { createWorkService, workItemId, type WorkItemId } from '../../../src/work/index.js';
import {
  faultInjectingCheckpoints,
  faultInjectingJournal,
  faultInjectingProjections,
  FaultInjector,
} from './faults.js';
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
    const value = this.nextValue++;
    return prefix === 'work' || prefix === 'resource'
      ? `${prefix}-${String(value).padStart(26, '0')}`
      : `${prefix}-${value}`;
  }
}

export class TestWorld {
  readonly clock = new FakeClock();
  readonly ids = new SequentialIds();
  readonly faults = new FaultInjector();
  readonly journal = faultInjectingJournal(new InMemoryEventJournal(this.clock), this.faults);
  readonly projections = faultInjectingProjections(new InMemoryProjectionStore(), this.faults);
  readonly checkpoints = faultInjectingCheckpoints(new InMemoryCheckpointStore(), this.faults);
  readonly activities = new ActivityRegistry();
  private readonly definitions: Record<string, CompiledWorkflow> = {};
  readonly work = createWorkService(this.journal);
  readonly resourceLookup = createResourceLookup({
    journal: this.journal,
    projections: this.projections,
  });

  readonly resources = createResourceService(this.journal, this.resourceLookup);
  readonly pullRequests = createPullRequestService(this.journal, this.work, this.resources);
  readonly orchestration = createOrchestrationService(
    this.journal,
    this.work,
    this.definitions,
    this.projections,
  );

  // resolve() falls back to this projection for historical (non-current) workflow
  // fingerprints; keep it caught up before any call that may hit that path.
  private readonly definitionProjections = new ProjectionRunner(
    this.journal,
    this.projections,
    this.checkpoints,
  );

  private recovery: RecoveryService | undefined;
  private execution = createExecutionService(
    this.journal,
    this.activities,
    { runnerPools: { standard: ['fake'] }, defaultRunnerPool: 'standard' },
    { clock: this.clock, ids: this.ids },
  );

  private cancellation = createWorkCancellationPolicy(
    this.work,
    this.orchestration,
    this.execution,
    this.clock,
    this.ids,
  );

  private advanceOnce = createAdvanceOnce(
    this.orchestration,
    this.execution,
    this.resources,
    this.clock,
    { ids: this.ids },
  );

  private readonly watchReactor = createWatchReactor(
    this.orchestration,
    this.journal,
    this.checkpoints,
    new RunRepository(this.journal),
  );

  private readonly resourceTransitionReactor = createResourceTransitionReactor(
    this.orchestration,
    createCapabilityResourceTransitionEvidence({
      resources: this.resources,
      policies: [
        {
          capabilities: [
            BuiltInResourceCapability.Mergeable,
            BuiltInResourceCapability.Reviewable,
            BuiltInResourceCapability.Approvable,
          ],
          policy: createPullRequestTransitionEvidence(this.pullRequests),
        },
      ],
    }),
    this.journal,
    this.checkpoints,
  );

  constructor() {
    this.orchestration.setWatchChildCancellation({
      cancelSupersededWatchChildren: (workflowInstanceIds) =>
        this.execution.cancelActive(
          workflowInstanceIds,
          ExecutionCancellationReason.WorkflowSuperseded,
        ),
    });
    this.orchestration.setAcceptSignalOperationCoordinator(async (operation) => {
      await this.resourceTransitionReactor.drain();
      return operation();
    });
  }

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

  async cancelWork(workItemId: WorkItemId, reason = 'operator cancellation') {
    return this.cancellation.cancelWork(workItemId, reason);
  }

  async closeWork(workItemId: WorkItemId, reason = 'operator close') {
    return this.cancellation.closeWork(workItemId, reason);
  }

  requestRunCancellation(runId: string, reason: NonNullable<RunView['cancellation']>['reason']) {
    return this.execution.requestCancellation(runId, reason);
  }

  confirmRunCancellation(runId: string) {
    return this.execution.confirmCancellation(runId);
  }

  restartExecution(inspector?: ExternalExecutionInspector): void {
    this.execution = createExecutionService(
      this.journal,
      this.activities,
      { runnerPools: { standard: ['fake'] }, defaultRunnerPool: 'standard' },
      { clock: this.clock, ids: this.ids },
    );
    this.orchestration.setWatchChildCancellation({
      cancelSupersededWatchChildren: (workflowInstanceIds) =>
        this.execution.cancelActive(
          workflowInstanceIds,
          ExecutionCancellationReason.WorkflowSuperseded,
        ),
    });
    this.cancellation = createWorkCancellationPolicy(
      this.work,
      this.orchestration,
      this.execution,
      this.clock,
      this.ids,
    );
    this.recovery =
      inspector === undefined
        ? undefined
        : new RecoveryService(
            this.journal,
            this.clock,
            inspector,
            this.activities,
            { leaseDurationMs: 60_000, leaseRenewalIntervalMs: 30_000 },
            this.orchestration,
          );
    const recovery =
      this.recovery === undefined ? undefined : createRecoveryCoordinator(this.recovery);
    const dispatchExecution =
      recovery === undefined
        ? this.execution
        : { ...this.execution, recoverActive: recovery.recoverActive };
    this.advanceOnce = createAdvanceOnce(
      this.orchestration,
      dispatchExecution,
      this.resources,
      this.clock,
      { ids: this.ids },
    );
  }

  resolveRun(runId: string, resolution: Parameters<RecoveryService['resolve']>[1]) {
    if (this.recovery === undefined) throw new Error('Recovery is not configured');
    return this.recovery.resolve(
      runId,
      resolution,
      this.command({ kind: 'operator', id: 'owner' }),
    );
  }

  async restartAndRecover(inspector: ExternalExecutionInspector): Promise<void> {
    this.restartExecution(inspector);
    await this.advance();
  }

  async discoverResource(
    input: Parameters<typeof this.resources.discover>[0],
  ): Promise<ResourceView> {
    return this.resources.discover(input, this.command());
  }

  correlateResource(resourceId: string, workItemId: WorkItemId, role: 'primary' | 'secondary') {
    return this.resources.correlate(resourceId as never, workItemId, role, this.command());
  }

  observePullRequest(input: Parameters<typeof this.pullRequests.observe>[0]) {
    return this.pullRequests.observe(input, this.command());
  }

  private async syncWorkflowDefinitions(): Promise<void> {
    await this.definitionProjections.runOnce(workflowDefinitionsProjection);
  }

  async startWorkflow(input: {
    workItemId: WorkItemId;
    workflowName: string;
    workflowInstanceId?: string;
    orchestrationGroupId?: string;
  }): Promise<WorkflowInstanceView> {
    await this.syncWorkflowDefinitions();
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

  async acceptSignal(
    workflowInstanceId: string,
    signal: Parameters<typeof this.orchestration.acceptSignal>[1],
  ) {
    await this.syncWorkflowDefinitions();
    return this.orchestration.acceptSignal(
      parseWorkflowInstanceId(workflowInstanceId),
      signal,
      this.command({ kind: 'operator', id: 'owner' }),
    );
  }

  blockWorkflow(workflowInstanceId: string, reason: string) {
    return this.orchestration.block(
      parseWorkflowInstanceId(workflowInstanceId),
      reason,
      this.command({ kind: 'operator', id: 'owner' }),
    );
  }

  async acceptOutcome(
    workflowInstanceId: string,
    activationId: string,
    outcome: Parameters<typeof this.orchestration.acceptOutcome>[0]['outcome'],
  ) {
    await this.syncWorkflowDefinitions();
    return this.orchestration.acceptOutcome(
      {
        workflowInstanceId: parseWorkflowInstanceId(workflowInstanceId),
        activationId: parseActivationId(activationId),
        outcome,
      },
      this.command({ kind: 'integration', id: 'synthetic-delivery' }),
    );
  }

  async resolveExecutionFailure(
    workflowInstanceId: string,
    input: Parameters<typeof this.orchestration.resolveExecutionFailure>[1],
  ) {
    await this.syncWorkflowDefinitions();
    return this.orchestration.resolveExecutionFailure(
      parseWorkflowInstanceId(workflowInstanceId),
      input,
      this.command({ kind: 'integration', id: 'synthetic-delivery' }),
    );
  }

  async requestSupplementalActivity(
    workflowInstanceId: string,
    request: Parameters<typeof this.orchestration.requestSupplementalActivity>[1],
  ) {
    await this.syncWorkflowDefinitions();
    return this.orchestration.requestSupplementalActivity(
      parseWorkflowInstanceId(workflowInstanceId),
      request,
      this.command({ kind: 'operator', id: 'owner' }),
    );
  }

  async advance(workItemId?: WorkItemId): Promise<AdvanceResult> {
    await this.syncWorkflowDefinitions();
    const result = await this.advanceOnce({
      ...(workItemId === undefined ? {} : { workItemId }),
      maxProgress: 1,
    });
    await this.watchReactor.runOnce();
    await this.resourceTransitionReactor.runOnce();
    return result;
  }

  async advanceUntilSettled(workItemId?: WorkItemId): Promise<AdvanceResult> {
    let result: AdvanceResult;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      result = await this.advance(workItemId);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const hasStartedRun = (await this.execution.list()).some((run) => run.status === 'started');
      const hasPendingActivation =
        (await this.orchestration.listPendingActivations(workItemId)).length > 0;
      if (!hasStartedRun && !hasPendingActivation) return result;
    }
    throw new Error(`Workflow did not settle after 20 ticks:\n${await this.trace()}`);
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
    await this.syncWorkflowDefinitions();
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
    return this.execution.list(
      activationId === undefined ? undefined : parseActivationId(activationId),
    );
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
