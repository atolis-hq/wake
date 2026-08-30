import { ResidentHost, TickHost, type AdvanceOnce } from '../control-plane/index.js';
import type { CompositionRoot, CompositionRootOptions } from './composition-root.js';
import type { SurfaceApplicationOptions } from './surface-applications.js';

export function composeControlPlaneHosts(
  advanceOnce: AdvanceOnce,
  sleep?: (signal: AbortSignal) => Promise<void>,
) {
  const tick = new TickHost(advanceOnce);
  return { tick, resident: new ResidentHost(tick, sleep) };
}

export type { CompositionRoot, CompositionRootOptions } from './composition-root.js';

export async function createCompositionRoot(
  wakeRoot: string,
  options: CompositionRootOptions = {},
) {
  const { createCompositionRoot: create } = await import('./composition-root.js');
  return create(wakeRoot, options);
}

export * from './resource-transition-evidence.js';

export * from './analytics-projection.js';

export * from './activation-scheduler-serialiser.js';

export * from './board-projection.js';

export * from './config/load-config.js';

export * from './initialise.js';

export * from './config/root-schema.js';

export * from './fake-scenarios.js';

export * from './paths.js';

export * from './projection-runtime.js';

export * from './runner-tick-adapter.js';

export type { SurfaceApplicationOptions, SurfaceApplications } from './surface-applications.js';

export async function createSurfaceApplications(
  root: CompositionRoot,
  options: SurfaceApplicationOptions = {},
) {
  const { createSurfaceApplications: create } = await import('./surface-applications.js');
  return create(root, options);
}

export * from './update-ledger.js';

export * from './update-maintenance-lease.js';

export * from './self-update-application.js';

export * from './source-update-port.js';

export * from './version.js';
