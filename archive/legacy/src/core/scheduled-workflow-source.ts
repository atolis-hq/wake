import { buildResourceUri } from '../domain/resource-uri.js';
import type { WakeConfig } from '../domain/types.js';
import { createUnkeyedEventEnvelope } from '../lib/event-log.js';
import { readJsonFile, writeJsonFile } from '../lib/json-file.js';
import { createWakePaths } from '../lib/paths.js';
import { isMissingPathError } from '../lib/state-health.js';
import type { UnkeyedEventEnvelope, WorkSource } from './contracts.js';

type StateStore = ReturnType<typeof import('../adapters/fs/state-store.js').createStateStore>;

type TriggerState = {
  schemaVersion: 1;
  workflow: string;
  lastFiredSlot: string;
  updatedAt: string;
};

type CronField = {
  matches(value: number): boolean;
};

const syntheticRepo = 'wake/internal';
const syntheticIssueNumber = 1;

function parseCronField(raw: string, min: number, max: number): CronField {
  const allowed = new Set<number>();

  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (trimmed.length === 0) {
      throw new Error(`invalid cron field "${raw}"`);
    }

    const stepMatch = /^(.*)\/(\d+)$/.exec(trimmed);
    const base = stepMatch?.[1] ?? trimmed;
    const step = stepMatch === null ? 1 : Number(stepMatch[2]);
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`invalid cron step "${trimmed}"`);
    }

    const range: [number, number] =
      base === '*'
        ? [min, max]
        : (() => {
            const match = /^(\d+)(?:-(\d+))?$/.exec(base);
            if (match === null) {
              throw new Error(`invalid cron segment "${trimmed}"`);
            }
            const start = Number(match[1]);
            const end = match[2] === undefined ? start : Number(match[2]);
            if (start < min || end > max || start > end) {
              throw new Error(`cron segment "${trimmed}" is outside ${min}-${max}`);
            }
            return [start, end] as [number, number];
          })();

    for (let value = range[0]; value <= range[1]; value += step) {
      allowed.add(value);
    }
  }

  return { matches: (value) => allowed.has(value) };
}

function parseCron(cron: string): CronField[] {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron schedule must have five fields: ${cron}`);
  }

  return [
    parseCronField(fields[0]!, 0, 59),
    parseCronField(fields[1]!, 0, 23),
    parseCronField(fields[2]!, 1, 31),
    parseCronField(fields[3]!, 1, 12),
    parseCronField(fields[4]!, 0, 6),
  ];
}

function matchesCron(date: Date, cron: CronField[]): boolean {
  return (
    cron[0]!.matches(date.getUTCMinutes()) &&
    cron[1]!.matches(date.getUTCHours()) &&
    cron[2]!.matches(date.getUTCDate()) &&
    cron[3]!.matches(date.getUTCMonth() + 1) &&
    cron[4]!.matches(date.getUTCDay())
  );
}

function floorToMinute(date: Date): Date {
  const copy = new Date(date);
  copy.setUTCSeconds(0, 0);
  return copy;
}

export function previousMatchingSlot(input: {
  cron: string;
  now: Date;
  after?: string;
}): string | null {
  const parsed = parseCron(input.cron);
  const slot = floorToMinute(input.now);
  const afterMs = input.after === undefined ? undefined : Date.parse(input.after);
  const lookbackMinutes = 366 * 24 * 60;

  for (let checked = 0; checked < lookbackMinutes; checked += 1) {
    const slotIso = slot.toISOString();
    if (afterMs !== undefined && slot.getTime() <= afterMs) {
      return null;
    }
    if (matchesCron(slot, parsed)) {
      return slotIso;
    }
    slot.setUTCMinutes(slot.getUTCMinutes() - 1);
  }

  return null;
}

function triggerStateFile(wakeRoot: string, workflow: string): string {
  return `${createWakePaths(wakeRoot).dataRoot}/triggers/${workflow}.json`;
}

async function readTriggerState(wakeRoot: string, workflow: string): Promise<TriggerState | null> {
  try {
    const raw = await readJsonFile<unknown>(triggerStateFile(wakeRoot, workflow));
    if (raw === null || typeof raw !== 'object') {
      return null;
    }
    const record = raw as Partial<TriggerState>;
    return record.schemaVersion === 1 &&
      record.workflow === workflow &&
      typeof record.lastFiredSlot === 'string' &&
      typeof record.updatedAt === 'string'
      ? {
          schemaVersion: 1,
          workflow,
          lastFiredSlot: record.lastFiredSlot,
          updatedAt: record.updatedAt,
        }
      : null;
  } catch (error) {
    if (isMissingPathError(error)) {
      return null;
    }
    throw error;
  }
}

function scheduledEventId(workflow: string, slot: string): string {
  return `scheduled-workflow-${workflow}-${slot.replace(/[^a-z0-9]+/gi, '-')}`;
}

function scheduledResourceUri(workflow: string, slot: string): string {
  return buildResourceUri('wake', 'schedule', `${workflow}@${slot}`);
}

function syntheticTicket(input: {
  workflow: string;
  slot: string;
  now: string;
}): UnkeyedEventEnvelope {
  const eventId = scheduledEventId(input.workflow, input.slot);
  const resourceUri = scheduledResourceUri(input.workflow, input.slot);
  const url = `https://wake.local/schedules/${encodeURIComponent(input.workflow)}/${encodeURIComponent(
    input.slot,
  )}`;

  return createUnkeyedEventEnvelope({
    eventId,
    streamScope: 'global-intake',
    direction: 'inbound',
    sourceSystem: 'wake',
    sourceEventType: 'ticket.upsert',
    sourceRefs: {
      repo: syntheticRepo,
      issueNumber: syntheticIssueNumber,
      sourceUrl: url,
      resourceUri,
    },
    occurredAt: input.slot,
    ingestedAt: input.now,
    trigger: 'immediate',
    payload: {
      ticket: {
        repo: syntheticRepo,
        number: syntheticIssueNumber,
        title: `Scheduled workflow: ${input.workflow}`,
        body: `Wake fired scheduled workflow "${input.workflow}" for cron slot ${input.slot}.`,
        labels: ['wake:scheduled-workflow', `wake:workflow.${input.workflow}`],
        assignees: [],
        isPullRequest: false,
        state: 'open',
        url,
        createdAt: input.slot,
        updatedAt: input.slot,
      },
      workflow: input.workflow,
      trigger: {
        kind: 'schedule',
        slot: input.slot,
        idempotencyKey: eventId,
      },
      providerEventType: 'wake.schedule.fired',
    },
    derivedHints: {
      workflow: input.workflow,
    },
  });
}

export function createScheduledWorkflowSource(deps: {
  config: WakeConfig;
  stateStore: StateStore;
  now: () => Date;
}): WorkSource {
  return {
    async pollEvents(): Promise<UnkeyedEventEnvelope[]> {
      const events: UnkeyedEventEnvelope[] = [];
      const now = deps.now();
      const nowIso = now.toISOString();

      for (const [workflow, definition] of Object.entries(deps.config.workflows)) {
        const cron = definition.trigger?.schedule?.cron;
        if (cron === undefined) {
          continue;
        }

        const state = await readTriggerState(deps.config.paths.wakeRoot, workflow);
        const slot = previousMatchingSlot({
          cron,
          now,
          ...(state?.lastFiredSlot === undefined ? {} : { after: state.lastFiredSlot }),
        });
        if (slot === null) {
          continue;
        }

        const eventId = scheduledEventId(workflow, slot);
        if ((await deps.stateStore.readEventEnvelope(eventId)) !== null) {
          await writeJsonFile(triggerStateFile(deps.config.paths.wakeRoot, workflow), {
            schemaVersion: 1,
            workflow,
            lastFiredSlot: slot,
            updatedAt: nowIso,
          } satisfies TriggerState);
          continue;
        }

        events.push(syntheticTicket({ workflow, slot, now: nowIso }));
      }

      return events;
    },
  };
}
