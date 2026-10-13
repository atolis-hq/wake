import { correlationId, EventActorKind } from '@atolis-hq/eventing';
import { CronTriggerPolicy, type TriggerInspectionView } from '../control-plane/index.js';
import {
  ApiCommandStatus,
  toWorkItemKey,
  TriggerStatus,
  type ApiApplications,
  type ApiCommandRequest,
  type TriggerResponse,
} from '../surfaces/index.js';
import type { CompositionRoot } from './composition-root.js';

export function createTriggerApplications(
  root: CompositionRoot,
  now: () => string,
): NonNullable<ApiApplications['triggers']> {
  async function list() {
    const view = await root.triggers.get();
    const ids = new Set([
      ...root.config.controlPlane.triggers.map((config) => config.id),
      ...Object.keys(view.pauses),
      ...view.requests.map((request) => request.triggerId),
      ...view.invocations.map((entry) => entry.claim.triggerId),
      ...(view.diagnostics ?? []).map((entry) => entry.triggerId),
    ]);
    const asOf = now();
    return { data: [...ids].sort().map((id) => present(id, view, asOf)), meta: { asOf } };
  }

  function present(id: string, view: TriggerInspectionView, asOf: string): TriggerResponse {
    const definition = root.config.controlPlane.triggers.find((config) => config.id === id) ?? null;
    const invocations = view.invocations
      .filter((entry) => entry.claim.triggerId === id)
      .sort((a, b) => b.claimedAt.localeCompare(a.claimedAt))
      .map((entry) => ({ ...entry, workItemKey: toWorkItemKey(entry.claim.workItemId) }));
    const pauseReason = view.pauses[id] ?? null;
    const running = invocations.some((entry) => entry.result === undefined);
    return {
      triggerId: id,
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
      pending: Object.values(view.coalesced).filter((entry) => entry.triggerId === id),
      latestSkip: view.diagnostics?.find((entry) => entry.triggerId === id) ?? null,
      invocations,
    };
  }

  async function command(id: string, request: ApiCommandRequest, pause: boolean) {
    if (!(await list()).data.some((entry) => entry.triggerId === id))
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
      const result = await list();
      const data = result.data.find((entry) => entry.triggerId === id);
      return data === undefined ? undefined : { data, meta: result.meta };
    },
    pause: (id, request) => command(id, request, true),
    resume: (id, request) => command(id, request, false),
  };
}
