import type { EntityRef } from '../../kernel/index.js';

export const ControlStreamKind = {
  Global: 'control-plane',
  Trigger: 'control-plane-trigger',
  TriggerInvocation: 'control-plane-trigger-invocation',
} as const;

export type GlobalControlStreamRef = EntityRef<typeof ControlStreamKind.Global, 'global'>;

export type TriggerControlStreamRef = EntityRef<typeof ControlStreamKind.Trigger>;

export type TriggerInvocationStreamRef = EntityRef<typeof ControlStreamKind.TriggerInvocation>;

export type ControlStreamRef =
  GlobalControlStreamRef | TriggerControlStreamRef | TriggerInvocationStreamRef;

export const controlPlaneStream = (): GlobalControlStreamRef => ({
  kind: ControlStreamKind.Global,
  id: 'global',
});

export const triggerControlStream = (coordinationKey: string): TriggerControlStreamRef => ({
  kind: ControlStreamKind.Trigger,
  id: coordinationKey,
});

export const triggerInvocationStream = (workItemId: string): TriggerInvocationStreamRef => ({
  kind: ControlStreamKind.TriggerInvocation,
  id: workItemId,
});
