import type { ApiApplications, WakeCliApplications } from '../surfaces/index.js';
import type { CompositionRoot } from './composition-root.js';
import { createSurfaceApiApplications } from './surface-api-applications.js';
import { createSurfaceCliApplications } from './surface-cli-applications.js';

export interface SurfaceApplicationOptions {
  readonly now?: () => string;
}

export interface SurfaceApplications {
  readonly api: ApiApplications;
  readonly cli: WakeCliApplications;
}

export function createSurfaceApplications(
  root: CompositionRoot,
  options: SurfaceApplicationOptions = {},
): SurfaceApplications {
  const now = options.now ?? (() => new Date().toISOString());
  const api = createSurfaceApiApplications(root, now);
  return { api, cli: createSurfaceCliApplications(root, api, now) };
}
