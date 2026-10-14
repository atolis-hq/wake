import type { CommandContext } from '@atolis-hq/eventing';
import type { TriggerConfig } from '../contracts/config.js';
import { ControlEventType, TriggerSourceKind } from '../contracts/events.js';
import { TriggerSkipReason } from '../contracts/trigger-diagnostics.js';
import type { TriggerDiagnostics } from './trigger-diagnostics.js';
import { consumedTriggerRequest, sourceIdentity, type TriggerFactInput } from './trigger-facts.js';
import type { TriggerView } from './trigger-projection.js';
import { hasActiveInvocation } from './trigger-rules.js';
import type { TriggerServiceDependencies } from './trigger-service-ports.js';

interface PendingTriggerPorts {
  readonly dependencies: TriggerServiceDependencies;
  readonly diagnostics: TriggerDiagnostics;
  readonly view: () => Promise<TriggerView>;
  readonly configured: (id: string) => TriggerConfig | undefined;
  readonly emit: (input: TriggerFactInput, context: CommandContext, id: string) => Promise<void>;
  readonly recover: (context: CommandContext) => Promise<void>;
}

export async function advancePendingTriggers(
  ports: PendingTriggerPorts,
  context: CommandContext,
): Promise<void> {
  const initial = await ports.view();
  for (const first of Object.values(initial.coalesced)) {
    if (hasActiveInvocation(initial, first.coordinationKey)) continue;
    // Manual admission failures consume only the manual commands; automatic work is judged separately.
    for (const manual of first.manualRequests) {
      const manualConfig = ports.configured(manual.triggerId);
      const manualReason = await ports.diagnostics.ineligibleReason(
        initial,
        manual.triggerId,
        manualConfig,
        manualConfig !== undefined,
        false,
        true,
      );
      if (manualReason !== undefined) await consume(ports, manual, manualReason, context);
    }
    const view = await ports.view();
    const request = view.coalesced[first.coordinationKey];
    if (request === undefined) continue;
    const config = ports.configured(request.triggerId);
    const identity = `trigger:${request.triggerId}:${sourceIdentity(request.source)}`;
    const reason = await pendingSkipReason(ports, view, request);
    if (reason !== undefined || config === undefined) {
      // Record every manual command's terminal outcome before consuming the shared slot.
      for (const pending of [...request.manualRequests, request])
        await consume(ports, pending, reason ?? TriggerSkipReason.Removed, context);
      continue;
    }
    await ports.emit(
      {
        eventType: ControlEventType.TriggerInvocationClaimed,
        payload: {
          triggerId: config.id,
          coordinationKey: request.coordinationKey,
          source: request.source,
          sources: request.sources,
          workItemId: ports.dependencies.ids.next('work'),
          workflowInstanceId: `workflow-${encodeURIComponent(identity)}`,
          workflowName: config.workflow,
        },
      },
      context,
      `${identity}:claim`,
    );
    await ports.recover(context);
  }
}

async function consume(
  ports: PendingTriggerPorts,
  pending: TriggerView['requests'][number],
  reason: TriggerSkipReason,
  context: CommandContext,
): Promise<void> {
  await ports.diagnostics.record(pending.triggerId, pending.source, reason);
  await ports.emit(
    consumedTriggerRequest(pending, reason),
    context,
    `trigger:consume:${pending.triggerId}:${sourceIdentity(pending.source)}`,
  );
}

async function pendingSkipReason(
  ports: PendingTriggerPorts,
  view: TriggerView,
  request: TriggerView['coalesced'][string],
): Promise<TriggerSkipReason | undefined> {
  // Sibling automatic occurrences cannot erase a manual command's admission controls.
  for (const pending of [request, ...request.manualRequests]) {
    const config = ports.configured(pending.triggerId);
    const reason = await ports.diagnostics.ineligibleReason(
      view,
      pending.triggerId,
      config,
      config !== undefined,
      false,
      pending.source.kind === TriggerSourceKind.Manual,
    );
    if (reason !== undefined) return reason;
  }
  return undefined;
}
