import type { EntityRef } from '../../kernel/index.js';

export const ControlStreamKind = { Global: 'control-plane' } as const;

export type ControlStreamRef = EntityRef<typeof ControlStreamKind.Global, 'global'>;

export const controlPlaneStream = (): ControlStreamRef => ({
  kind: ControlStreamKind.Global,
  id: 'global',
});
