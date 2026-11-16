import type { EventJournal } from '@atolis-hq/eventing';
import { z } from 'zod';
import type { ResourceId, ResourceService } from '../../../resources/index.js';
import { adapterId } from '../../contracts/identifiers.js';
import { integrationStream } from '../../contracts/streams.js';
import { GitHubEventType, selectGitHubAdapterEvent } from '../contracts/events.js';

const checkRun = z.object({ name: z.string(), conclusion: z.string().nullable().optional() });
const status = z.object({ context: z.string(), state: z.string() });
const passingConclusions = new Set(['success', 'neutral', 'skipped']);

/** Diagnostic evidence is separate from the authoritative aggregate check state. */
export function createFailingCheckNamesReader(
  journal: EventJournal,
  resources: Pick<ResourceService, 'get'>,
) {
  return async (
    resourceId: ResourceId,
    headRevision: string,
  ): Promise<readonly string[] | undefined> => {
    const resource = await resources.get(resourceId);
    if (resource === null) return undefined;
    let adapter;
    try {
      adapter = adapterId(resource.externalKey.adapter);
    } catch {
      return undefined;
    }
    const events = await journal.readStream(integrationStream(adapter));
    for (const event of [...events].reverse()) {
      const observed = selectGitHubAdapterEvent(event);
      if (observed?.event.eventType !== GitHubEventType.WorkObserved) continue;
      const payload = observed.event.payload;
      if (payload.kind !== 'pull-request' || payload.externalKey !== resource.externalKey.key)
        continue;
      if (payload.headRevision !== headRevision) return undefined;
      return namesFromEvidence(payload.raw);
    }
    return undefined;
  };
}

function namesFromEvidence(raw: Readonly<Record<string, unknown>>): readonly string[] | undefined {
  const runs = z.array(checkRun).safeParse(raw.checkRuns);
  const statuses = z.array(status).safeParse(raw.statuses);
  if (!runs.success && !statuses.success) return undefined;
  return [
    ...new Set([
      ...(runs.success
        ? runs.data
            .filter((run) => run.conclusion != null && !passingConclusions.has(run.conclusion))
            .map((run) => run.name)
        : []),
      ...(statuses.success
        ? statuses.data
            .filter((entry) => entry.state === 'failure' || entry.state === 'error')
            .map((entry) => entry.context)
        : []),
    ]),
  ];
}
