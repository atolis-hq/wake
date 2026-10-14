import type { TriggerConfig } from '../contracts/config.js';
import type { TriggerSkipDiagnostic } from '../contracts/trigger-diagnostics.js';
import type { TriggerInvocationView, TriggerView } from './trigger-projection.js';

export function inspectTriggers(
  view: TriggerView,
  invocations: readonly TriggerInvocationView[],
  diagnostics: readonly TriggerSkipDiagnostic[],
  configurations: readonly TriggerConfig[],
  keyOf: (id: string) => string,
) {
  const ids = new Set([
    ...configurations.map((config) => config.id),
    ...view.requests.map((request) => request.triggerId),
    ...invocations.map((invocation) => invocation.claim.triggerId),
    ...Object.keys(view.pauses),
  ]);
  return {
    ...view,
    invocations,
    diagnostics,
    coordinationKeys: Object.fromEntries([...ids].map((id) => [id, keyOf(id)])),
  };
}
