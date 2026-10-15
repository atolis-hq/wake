import { correlationId, EventActorKind } from '@atolis-hq/eventing';
import { createHash } from 'node:crypto';
import {
  OperatorInstructionsConflict,
  operatorInstructionsProjection,
} from '../artifacts/index.js';
import { CronTriggerPolicy, type TriggerInspectionView } from '../control-plane/index.js';
import { selectOperatorRetryTarget } from '../orchestration/index.js';
import {
  ApiCommandStatus,
  toWorkItemKey,
  TriggerStatus,
  type ApiApplications,
  type ApiCommandRequest,
  type TriggerResponse,
} from '../surfaces/index.js';
import { workItemId, WorkStatus } from '../work/index.js';
import type { CompositionRoot } from './composition-root.js';

export function createTriggerApplications(
  root: CompositionRoot,
  now: () => string,
): NonNullable<ApiApplications['triggers']> {
  async function inspect() {
    const view = await root.triggers.get();
    const ids = new Set([
      ...root.config.controlPlane.triggers.map((config) => config.id),
      ...Object.keys(view.pauses),
      ...view.requests.map((request) => request.triggerId),
      ...view.invocations.map((entry) => entry.claim.triggerId),
      ...(view.diagnostics ?? []).map((entry) => entry.triggerId),
    ]);
    const asOf = now();
    return {
      data: await Promise.all([...ids].sort().map((id) => present(id, view, asOf))),
      meta: { asOf },
    };
  }

  async function list() {
    const result = await inspect();
    await root.projectionSubscriptions.catchUp(operatorInstructionsProjection);
    const configuredScopes = new Set(
      root.config.controlPlane.triggers.flatMap((trigger) =>
        trigger.contextScope === undefined ? [] : [trigger.contextScope],
      ),
    );
    const orphanedInstructions = (
      await root.operatorInstructions.list(root.projections, configuredScopes)
    ).map(({ contextScope, revisionId, content, author, occurredAt }) => ({
      contextScope,
      revisionId,
      content,
      author,
      occurredAt,
    }));
    return { ...result, orphanedInstructions };
  }

  async function present(
    id: string,
    view: TriggerInspectionView,
    asOf: string,
  ): Promise<TriggerResponse> {
    const definition = root.config.controlPlane.triggers.find((config) => config.id === id) ?? null;
    const invocations = view.invocations
      .filter((entry) => entry.claim.triggerId === id)
      .sort((a, b) => b.claimedAt.localeCompare(a.claimedAt))
      .map((entry) => ({ ...entry, workItemKey: toWorkItemKey(entry.claim.workItemId) }));
    const pauseReason = view.pauses[id] ?? null;
    const coordinationKey = view.coordinationKeys[id] ?? id;
    const activeInvocation = await inspectHolder(coordinationKey, view);
    const running = activeInvocation !== null;
    return {
      triggerId: id,
      activeInvocation,
      definition,
      paused: pauseReason !== null,
      pauseReason,
      status:
        definition === null
          ? TriggerStatus.Removed
          : pauseReason !== null
            ? TriggerStatus.Paused
            : running
              ? TriggerStatus.Running
              : TriggerStatus.Enabled,
      nextOccurrence:
        definition?.on.cron === undefined
          ? null
          : new CronTriggerPolicy().nextOccurrence(definition.on.cron, asOf),
      pending: Object.values(view.coalesced)
        .filter((entry) => entry.coordinationKey === coordinationKey)
        .map((entry) => ({
          ...entry,
          activeWorkItemId: activeInvocation?.activeWorkItemId ?? null,
        })),
      latestSkip: view.diagnostics?.find((entry) => entry.triggerId === id) ?? null,
      invocations,
    };
  }

  async function inspectHolder(
    coordinationKey: string,
    view: TriggerInspectionView,
  ): Promise<TriggerResponse['activeInvocation']> {
    const holder = view.invocations.find(
      (entry) => entry.result === undefined && entry.claim.coordinationKey === coordinationKey,
    );
    if (holder === undefined) return null;
    const workflows = (await root.orchestration.listAll()).filter(
      (entry) => entry.workItemId === holder.claim.workItemId,
    );
    const workflow = workflows.find(
      (entry) => entry.workflowInstanceId === holder.claim.workflowInstanceId,
    );
    const work = await root.work.get(workItemId(holder.claim.workItemId));
    return {
      activeWorkItemId: holder.claim.workItemId,
      workItemKey: toWorkItemKey(holder.claim.workItemId),
      triggerId: holder.claim.triggerId,
      workflowInstanceId: holder.claim.workflowInstanceId,
      workflowStatus: workflow?.status ?? null,
      blockReason: workflow?.blockReason ?? null,
      retryEligible:
        work !== null &&
        work.deleted !== true &&
        !work.frozen &&
        work.state === WorkStatus.Open &&
        selectOperatorRetryTarget(workflows) !== undefined,
    };
  }

  async function command(id: string, request: ApiCommandRequest, pause: boolean) {
    if (!(await inspect()).data.some((entry) => entry.triggerId === id))
      return {
        conflict: true as const,
        code: 'trigger-not-found',
        detail: 'Trigger definition and history are unavailable',
      };
    const context = {
      commandId: 'trigger:' + request.idempotencyKey,
      correlationId: correlationId('trigger:' + request.idempotencyKey),
      occurredAt: now(),
      actor: { kind: EventActorKind.Operator, id: 'web' },
    };
    if (pause) await root.triggers.pause(id, 'Operator pause', context);
    else await root.triggers.resume(id, context);
    return {
      commandId: context.commandId,
      idempotencyKey: request.idempotencyKey,
      acceptedAt: now(),
      status: ApiCommandStatus.Completed,
    };
  }

  return {
    list,
    async detail(id) {
      const result = await inspect();
      const data = result.data.find((entry) => entry.triggerId === id);
      if (data === undefined) return undefined;
      const scope = data.definition?.contextScope;
      const instructions =
        scope === undefined ? null : await root.operatorInstructions.current(scope);
      return {
        data: {
          ...data,
          operatorInstructions:
            instructions === null
              ? null
              : {
                  contextScope: instructions.contextScope,
                  revisionId: instructions.revisionId,
                  content: instructions.content,
                  author: instructions.author,
                  occurredAt: instructions.occurredAt,
                },
        },
        meta: result.meta,
      };
    },
    async saveInstructions(id, request) {
      const scope = root.config.controlPlane.triggers.find(
        (trigger) => trigger.id === id,
      )?.contextScope;
      if (scope === undefined)
        return {
          conflict: true,
          code: 'trigger-no-context-scope',
          detail:
            'This trigger has no explicit contextScope. Configure a named scope before editing instructions.',
        };
      const context = {
        commandId: 'operator-instructions:' + request.idempotencyKey,
        correlationId: correlationId(request.idempotencyKey),
        occurredAt: now(),
        actor: { kind: EventActorKind.Operator, id: 'web' },
      };
      try {
        await root.operatorInstructions.save(
          {
            contextScope: scope,
            content: request.content,
            expectedRevisionId: request.expectedRevisionId,
            revisionId: createHash('sha256').update(request.idempotencyKey).digest('hex'),
          },
          context,
        );
      } catch (error) {
        if (error instanceof OperatorInstructionsConflict)
          return { conflict: true, code: 'operator-instructions-conflict', detail: error.message };
        if (error instanceof Error && error.message.includes('byte limit'))
          return {
            conflict: true,
            code: 'operator-instructions-size-limit',
            detail: error.message,
          };
        throw error;
      }
      return {
        commandId: context.commandId,
        idempotencyKey: request.idempotencyKey,
        acceptedAt: now(),
        status: ApiCommandStatus.Completed,
      };
    },
    async run(id, request) {
      if (!root.config.controlPlane.triggers.some((trigger) => trigger.id === id))
        return {
          conflict: true,
          code: 'trigger-not-found',
          detail: 'Trigger definition is unavailable',
        };
      const context = {
        commandId: 'trigger:' + request.idempotencyKey,
        correlationId: correlationId('trigger:' + request.idempotencyKey),
        occurredAt: now(),
        actor: { kind: EventActorKind.Operator, id: 'web' },
      };
      const triggerOutcome = await root.triggers.requestManual(id, context);
      return {
        commandId: context.commandId,
        idempotencyKey: request.idempotencyKey,
        acceptedAt: now(),
        status: ApiCommandStatus.Completed,
        triggerOutcome,
      };
    },
    pause: (id, request) => command(id, request, true),
    resume: (id, request) => command(id, request, false),
  };
}
