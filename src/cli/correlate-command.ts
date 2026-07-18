import { randomUUID } from 'node:crypto';

import type { createStateStore } from '../adapters/fs/state-store.js';
import type { ResourceIndex } from '../core/contracts.js';
import { createProjectionUpdater } from '../core/projection-updater.js';
import type { Clock } from '../lib/clock.js';
import { createEventEnvelope } from '../lib/event-log.js';
import { CORRELATION_REGISTERED_EVENT } from '../domain/schema.js';
import { correlationRoleSchema, resourceUriSchema } from '../domain/resource-uri.js';

type StateStore = ReturnType<typeof createStateStore>;

/**
 * `wake correlate <workItemKey> <resourceUri> [--role <role>]` — the operator
 * escape hatch for the correlation contract (spec §5/§6, ADR 0001).
 *
 * This command appends a `wake.correlation.registered` event with
 * `provenance: 'operator-declared'` and `relation: 'primary'`, then lets
 * `projection-updater`'s fold decide the outcome (including any downgrade to
 * `secondary` under the one-primary rule). It must never write the resource
 * index or the projection directly — that would bypass replay honesty
 * (`rm -rf state/` + replay must reproduce the same result).
 */
export async function runCorrelateCommand(input: {
  args: string[];
  stateStore: StateStore;
  resourceIndex: ResourceIndex;
  clock: Clock;
  readFlag: (name: string, args: string[]) => string | undefined;
  log?: (message: string) => void;
}): Promise<void> {
  const log = input.log ?? console.log;
  const [workItemKey, resourceUriArg] = input.args;

  if (workItemKey === undefined || resourceUriArg === undefined) {
    throw new Error('Usage: wake correlate <workItemKey> <resourceUri> [--role <role>]');
  }

  const roleFlag = input.readFlag('--role', input.args) ?? 'implementation';
  const roleResult = correlationRoleSchema.safeParse(roleFlag);
  if (!roleResult.success) {
    throw new Error(
      `Invalid --role: ${roleFlag} (must be one of ${correlationRoleSchema.options.join(', ')})`,
    );
  }

  const uriResult = resourceUriSchema.safeParse(resourceUriArg);
  if (!uriResult.success) {
    throw new Error(
      `Invalid resourceUri: ${resourceUriArg} (must match <provider>:<kind>:<locator>)`,
    );
  }

  const projection = await input.stateStore.readIssueState(workItemKey);
  if (projection === null) {
    throw new Error(`Unknown workItemKey: ${workItemKey}`);
  }

  const now = input.clock.now().toISOString();
  const event = createEventEnvelope({
    eventId: `operator-correlate-${randomUUID()}`,
    workItemKey,
    streamScope: 'work-item',
    direction: 'internal',
    sourceSystem: 'wake',
    sourceEventType: CORRELATION_REGISTERED_EVENT,
    sourceRefs: {},
    occurredAt: now,
    ingestedAt: now,
    trigger: 'context-only',
    payload: {
      resourceUri: uriResult.data,
      role: roleResult.data,
      relation: 'primary',
      provenance: 'operator-declared',
    },
  });

  const appended = await input.stateStore.appendEventEnvelope(event);

  const projectionUpdater = createProjectionUpdater({
    stateStore: input.stateStore,
    resourceIndex: input.resourceIndex,
  });
  await projectionUpdater.rebuildFromEvents([appended]);

  log(`Registered ${uriResult.data} against ${workItemKey}`);
}
