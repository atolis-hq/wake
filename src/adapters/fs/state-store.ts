import { access, appendFile, mkdir, readFile, readdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  parseEventEnvelope,
  parseIssueStateRecord,
  parseLedger,
  parseRunRecord,
  parseSourceStateRecord,
  parseWakeConfig,
} from '../../domain/schema.js';
import { isTerminalStage } from '../../domain/stages.js';
import type {
  EventEnvelope,
  IssueStateRecord,
  RunRecord,
  SourceStateRecord,
  WakeConfig,
  WakeLedger,
} from '../../domain/types.js';
import { appendJsonLine, readJsonFile, writeJsonFile } from '../../lib/json-file.js';
import { createWakePaths } from '../../lib/paths.js';

type ListIssueStatesOptions = {
  includeArchived?: boolean;
  archiveFreshnessDays?: number;
  now?: Date;
};

type EventFeedFilter = {
  limit?: number;
  workItemKey?: string;
  direction?: EventEnvelope['direction'];
  type?: string;
};

async function readIssueStateFile(file: string): Promise<IssueStateRecord | null> {
  try {
    return parseIssueStateRecord(await readJsonFile(file));
  } catch {
    return null;
  }
}

async function readRunRecordFile(file: string): Promise<RunRecord | null> {
  try {
    return parseRunRecord(await readJsonFile(file));
  } catch {
    return null;
  }
}

async function readEventFile(file: string): Promise<EventEnvelope[]> {
  try {
    const raw = await readFile(file, 'utf8');
    const envelopes: EventEnvelope[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }

      const parsed = JSON.parse(trimmed) as unknown;
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        'eventId' in parsed &&
        'sourceEventType' in parsed
      ) {
        envelopes.push(parseEventEnvelope(parsed));
      }
    }
    return envelopes;
  } catch {
    return [];
  }
}

function issueArchiveAgeDate(item: IssueStateRecord): string {
  const stageChangedAt = item.wake.stageHistory.at(-1)?.changedAt;
  return (
    [stageChangedAt, item.wake.syncedAt, item.issue.updatedAt]
      .filter((value): value is string => value !== undefined)
      .sort()
      .at(-1) ?? item.wake.syncedAt
  );
}

function shouldArchiveIssueState(
  item: IssueStateRecord,
  options: Required<Pick<ListIssueStatesOptions, 'archiveFreshnessDays' | 'now'>>,
): boolean {
  if (!isTerminalStage(item.wake.stage) && item.issue.state !== 'closed') {
    return false;
  }

  const ageMs = options.now.getTime() - Date.parse(issueArchiveAgeDate(item));
  return Number.isFinite(ageMs) && ageMs > options.archiveFreshnessDays * 24 * 60 * 60 * 1000;
}

export async function listRunRecords(wakeRoot: string): Promise<RunRecord[]> {
  const runsRoot = join(wakeRoot, 'runs');
  const recordsById = new Map<string, RunRecord>();

  try {
    const files = (await readdir(runsRoot)).filter((file) => file.endsWith('.json')).sort();

    for (const file of files) {
      const record = await readRunRecordFile(join(runsRoot, file));
      if (record !== null) {
        recordsById.set(record.runId, record);
      }
    }
  } catch {
    // The date-bucketed layout below may still exist.
  }

  try {
    const byDateRoot = join(runsRoot, 'by-date');
    const dateDirs = (await readdir(byDateRoot)).sort();
    for (const dateDir of dateDirs) {
      const files = (await readdir(join(byDateRoot, dateDir)).catch(() => []))
        .filter((file) => file.endsWith('.json'))
        .sort();
      for (const file of files) {
        const record = await readRunRecordFile(join(byDateRoot, dateDir, file));
        if (record !== null) {
          recordsById.set(record.runId, record);
        }
      }
    }
  } catch {
    // Old wake homes only have root-level run files.
  }

  return [...recordsById.values()].sort((left, right) =>
    left.startedAt.localeCompare(right.startedAt),
  );
}

async function listRunRecordsForDate(wakeRoot: string, date: string): Promise<RunRecord[]> {
  const runsRoot = join(wakeRoot, 'runs');
  const recordsById = new Map<string, RunRecord>();

  const bucketFiles = (await readdir(join(runsRoot, 'by-date', date)).catch(() => []))
    .filter((file) => file.endsWith('.json'))
    .sort();
  for (const file of bucketFiles) {
    const record = await readRunRecordFile(join(runsRoot, 'by-date', date, file));
    if (record !== null) {
      recordsById.set(record.runId, record);
    }
  }

  if (recordsById.size === 0) {
    const legacyFiles = (await readdir(runsRoot).catch(() => []))
      .filter((file) => file.endsWith('.json'))
      .sort();
    for (const file of legacyFiles) {
      const record = await readRunRecordFile(join(runsRoot, file));
      if (record?.startedAt.slice(0, 10) === date) {
        recordsById.set(record.runId, record);
      }
    }
  }

  return [...recordsById.values()].sort((left, right) =>
    left.startedAt.localeCompare(right.startedAt),
  );
}

async function listRecentRunRecords(wakeRoot: string, limit: number): Promise<RunRecord[]> {
  const runsRoot = join(wakeRoot, 'runs');
  const recordsById = new Map<string, RunRecord>();
  const dateDirs = (await readdir(join(runsRoot, 'by-date')).catch(() => [])).sort().reverse();

  for (const dateDir of dateDirs) {
    const records = await listRunRecordsForDate(wakeRoot, dateDir);
    for (const record of records.reverse()) {
      recordsById.set(record.runId, record);
      if (recordsById.size >= limit) {
        return [...recordsById.values()].sort((left, right) =>
          right.startedAt.localeCompare(left.startedAt),
        );
      }
    }
  }

  if (recordsById.size === 0) {
    return (await listRunRecords(wakeRoot))
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .slice(0, limit);
  }

  return [...recordsById.values()].sort((left, right) =>
    right.startedAt.localeCompare(left.startedAt),
  );
}

export function createStateStore({ wakeRoot }: { wakeRoot: string }) {
  const paths = createWakePaths(wakeRoot);

  return {
    paths,
    async ensureWakeRoot(): Promise<void> {
      await mkdir(wakeRoot, { recursive: true });
    },
    async writeConfig(record: WakeConfig): Promise<WakeConfig> {
      const parsed = parseWakeConfig(record);
      await writeJsonFile(paths.configFile, parsed);
      return parsed;
    },
    async writeLedger(record: WakeLedger): Promise<WakeLedger> {
      const parsed = parseLedger(record);
      await writeJsonFile(paths.ledgerFile, parsed);
      return parsed;
    },
    async readLedger(): Promise<WakeLedger | null> {
      try {
        return parseLedger(await readJsonFile(paths.ledgerFile));
      } catch {
        return null;
      }
    },
    async writeIssueState(record: IssueStateRecord): Promise<IssueStateRecord> {
      const parsed = parseIssueStateRecord(record);
      await writeJsonFile(paths.workItemStateFile(parsed.workItemKey), parsed);
      return parsed;
    },
    async readIssueState(workId: string): Promise<IssueStateRecord | null> {
      return (
        (await readIssueStateFile(paths.workItemStateFile(workId))) ??
        (await readIssueStateFile(paths.archivedWorkItemStateFile(workId)))
      );
    },
    async writeRunRecord(record: RunRecord): Promise<RunRecord> {
      const parsed = parseRunRecord(record);
      await writeJsonFile(paths.runFile(parsed.runId), parsed);
      await writeJsonFile(paths.runDateFile(parsed.startedAt.slice(0, 10), parsed.runId), parsed);
      return parsed;
    },
    async writeSourceState(record: SourceStateRecord): Promise<SourceStateRecord> {
      const parsed = parseSourceStateRecord(record);
      await writeJsonFile(paths.sourceStateFile(parsed.source, parsed.key), parsed);
      return parsed;
    },
    async readRunRecord(runId: string): Promise<RunRecord | null> {
      try {
        return parseRunRecord(await readJsonFile(paths.runFile(runId)));
      } catch {
        const recent = await listRecentRunRecords(wakeRoot, 500);
        return recent.find((record) => record.runId === runId) ?? null;
      }
    },
    async listRunRecords(): Promise<RunRecord[]> {
      return listRunRecords(wakeRoot);
    },
    async listRunRecordsForDate(date: string): Promise<RunRecord[]> {
      return listRunRecordsForDate(wakeRoot, date);
    },
    async listRecentRunRecords(limit = 10): Promise<RunRecord[]> {
      return listRecentRunRecords(wakeRoot, limit);
    },
    async readSourceState(source: string, key: string): Promise<SourceStateRecord | null> {
      try {
        return parseSourceStateRecord(await readJsonFile(paths.sourceStateFile(source, key)));
      } catch {
        return null;
      }
    },
    async appendEventEnvelope(record: EventEnvelope): Promise<EventEnvelope> {
      const parsed = parseEventEnvelope(record);
      const existing = await this.readEventEnvelope(parsed.eventId);
      if (existing !== null) {
        return existing;
      }
      await appendJsonLine(paths.eventFile(parsed.ingestedAt.slice(0, 10)), parsed);
      await writeJsonFile(paths.eventEnvelopeFile(parsed.eventId), parsed);
      return parsed;
    },
    async readEventEnvelope(eventId: string): Promise<EventEnvelope | null> {
      try {
        return parseEventEnvelope(await readJsonFile(paths.eventEnvelopeFile(eventId)));
      } catch {
        return null;
      }
    },
    async listIssueStates(options: ListIssueStatesOptions = {}): Promise<IssueStateRecord[]> {
      const stateRoot = join(wakeRoot, 'state');
      try {
        const items: IssueStateRecord[] = [];
        const includeArchived = options.includeArchived ?? false;
        const archiveOptions =
          options.archiveFreshnessDays === undefined
            ? null
            : {
                archiveFreshnessDays: options.archiveFreshnessDays,
                now: options.now ?? new Date(),
              };

        // state/ is flat: state/<workId>.json, plus state/archive/ and the
        // reverse index's own state/index/ shards. Only those two subdirectories
        // exist, and index/ holds `{ resourceUri: workItemKey }` maps that are
        // not projections at all — skip it rather than parse-and-discard.
        const visit = async (dir: string, isArchive: boolean): Promise<void> => {
          const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
          for (const entry of entries) {
            if (entry.isDirectory()) {
              if (entry.name === 'index') {
                continue;
              }
              if (entry.name === 'archive' && includeArchived) {
                await visit(join(dir, entry.name), true);
              }
              continue;
            }

            if (!entry.isFile() || !entry.name.endsWith('.json')) {
              continue;
            }

            const file = join(dir, entry.name);
            const record = await readIssueStateFile(file);
            if (record === null) {
              continue;
            }

            if (
              archiveOptions !== null &&
              !isArchive &&
              shouldArchiveIssueState(record, archiveOptions)
            ) {
              const archivePath = paths.archivedWorkItemStateFile(record.workItemKey);
              await mkdir(dirname(archivePath), { recursive: true });
              await rename(file, archivePath).catch(() => undefined);
              continue;
            }

            items.push(record);
          }
        };

        await visit(stateRoot, false);

        const byWorkItemKey = new Map<string, IssueStateRecord>();
        for (const item of items) {
          byWorkItemKey.set(item.workItemKey, item);
        }

        return [...byWorkItemKey.values()].sort((left, right) =>
          left.workItemKey.localeCompare(right.workItemKey),
        );
      } catch {
        return [];
      }
    },
    async listEventEnvelopes(): Promise<EventEnvelope[]> {
      const eventsRoot = join(wakeRoot, 'events');
      try {
        const files = (await readdir(eventsRoot)).sort();
        const envelopes: EventEnvelope[] = [];

        for (const file of files) {
          envelopes.push(...(await readEventFile(join(eventsRoot, file))));
        }

        return envelopes;
      } catch {
        return [];
      }
    },
    async listRecentEventEnvelopes(filter: EventFeedFilter = {}): Promise<EventEnvelope[]> {
      const limit = filter.limit ?? 200;
      const eventsRoot = join(wakeRoot, 'events');
      const files = (await readdir(eventsRoot).catch(() => []))
        .filter((file) => file.endsWith('.jsonl'))
        .sort()
        .reverse();
      const results: EventEnvelope[] = [];

      for (const file of files) {
        const events = await readEventFile(join(eventsRoot, file));
        for (const event of events.reverse()) {
          if (filter.workItemKey !== undefined && event.workItemKey !== filter.workItemKey) {
            continue;
          }
          if (filter.direction !== undefined && event.direction !== filter.direction) {
            continue;
          }
          if (filter.type !== undefined && event.sourceEventType !== filter.type) {
            continue;
          }
          results.push(event);
          if (results.length >= limit) {
            return results;
          }
        }
      }

      return results;
    },
    async listEventEnvelopesForWorkItem(workItemKey: string, limit = 10): Promise<EventEnvelope[]> {
      const projection = await this.readIssueState(workItemKey);
      const recentEventIds = projection?.wake.recentEventIds.slice(-limit) ?? [];
      const envelopes: EventEnvelope[] = [];

      for (const eventId of recentEventIds) {
        const envelope = await this.readEventEnvelope(eventId);
        if (envelope?.workItemKey === workItemKey) {
          envelopes.push(envelope);
        }
      }

      return envelopes;
    },
    async appendLog(date: string, line: string): Promise<void> {
      await mkdir(wakeRoot, { recursive: true });
      await appendFile(paths.logFile(date), `${line}\n`, 'utf8');
    },
    // Only the manual pause file is a hard stop on the whole loop. Quota
    // pauses are now per-runner (ledger.runners, #67): a paused runner skips
    // itself via routing fallback inside a tick, but the tick loop itself must
    // keep running so polling, delivery retries, and other tiers still make
    // progress while one runner is paused.
    async isPaused(_now = new Date()): Promise<boolean> {
      try {
        await access(paths.pauseFile);
        return true;
      } catch {
        return false;
      }
    },
    async readEventLog(date: string): Promise<string> {
      return readFile(paths.eventFile(date), 'utf8');
    },
  };
}
