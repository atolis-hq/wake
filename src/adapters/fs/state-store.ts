import { access, appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  parseEventEnvelope,
  parseIssueStateRecord,
  parseLedger,
  parseRunRecord,
  parseSourceStateRecord,
  parseWakeConfig,
} from '../../domain/schema.js';
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

function issueRefFromWorkItemKey(
  workItemKey: string,
): { source?: string; repo: string; issueNumber: number } | null {
  const sourceMarker = workItemKey.indexOf(':');
  const source =
    sourceMarker === -1 ? undefined : workItemKey.slice(0, sourceMarker);
  const unprefixedKey =
    sourceMarker === -1 ? workItemKey : workItemKey.slice(sourceMarker + 1);
  const marker = unprefixedKey.lastIndexOf('#');
  if (marker === -1) {
    return null;
  }

  const repo = unprefixedKey.slice(0, marker);
  const issueNumber = Number(unprefixedKey.slice(marker + 1));
  if (repo.length === 0 || !Number.isInteger(issueNumber) || issueNumber <= 0) {
    return null;
  }

  return source === undefined ? { repo, issueNumber } : { source, repo, issueNumber };
}

function namespacedWorkItemKey(workItemKey: string, source = 'github'): string {
  return workItemKey.includes(':') ? workItemKey : `${source}:${workItemKey}`;
}

async function readIssueStateFile(file: string): Promise<IssueStateRecord | null> {
  try {
    return parseIssueStateRecord(await readJsonFile(file));
  } catch {
    return null;
  }
}

export async function listRunRecords(wakeRoot: string): Promise<RunRecord[]> {
  const runsRoot = join(wakeRoot, 'runs');

  try {
    const files = (await readdir(runsRoot))
      .filter((file) => file.endsWith('.json'))
      .sort();
    const records: RunRecord[] = [];

    for (const file of files) {
      records.push(parseRunRecord(await readJsonFile(join(runsRoot, file))));
    }

    return records;
  } catch {
    return [];
  }
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
      await writeJsonFile(
        paths.issueStateFile(parsed.origin ?? 'github', parsed.issue.repo, parsed.issue.number),
        parsed,
      );
      return parsed;
    },
    async readIssueState(
      repo: string,
      issueNumber: number,
      source?: string,
    ): Promise<IssueStateRecord | null> {
      const sources = source === undefined ? ['github'] : [source];
      for (const sourceName of sources) {
        const record = await readIssueStateFile(
          paths.issueStateFile(sourceName, repo, issueNumber),
        );
        if (record !== null) {
          return record;
        }
      }

      const legacy = await readIssueStateFile(paths.legacyIssueStateFile(repo, issueNumber));
      if (legacy !== null) {
        return legacy;
      }

      if (source !== undefined) {
        return null;
      }

      try {
        const stateRoot = join(wakeRoot, 'state');
        const sourceDirs = await readdir(stateRoot);
        for (const sourceDir of sourceDirs) {
          const record = await readIssueStateFile(
            paths.issueStateFile(sourceDir, repo, issueNumber),
          );
          if (record !== null) {
            return record;
          }
        }
      } catch {
        return null;
      }
      return null;
    },
    async writeRunRecord(record: RunRecord): Promise<RunRecord> {
      const parsed = parseRunRecord(record);
      await writeJsonFile(paths.runFile(parsed.runId), parsed);
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
        return null;
      }
    },
    async listRunRecords(): Promise<RunRecord[]> {
      return listRunRecords(wakeRoot);
    },
    async readSourceState(source: string, key: string): Promise<SourceStateRecord | null> {
      try {
        return parseSourceStateRecord(
          await readJsonFile(paths.sourceStateFile(source, key)),
        );
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
    async listIssueStates(): Promise<IssueStateRecord[]> {
      const stateRoot = join(wakeRoot, 'state');
      try {
        const repoDirs = await readdir(stateRoot);
        const items: IssueStateRecord[] = [];

        for (const firstLevelDir of repoDirs) {
          const firstLevelPath = join(stateRoot, firstLevelDir);
          const childEntries = await readdir(firstLevelPath);
          for (const childEntry of childEntries) {
            if (childEntry.endsWith('.json')) {
              const record = await readIssueStateFile(join(firstLevelPath, childEntry));
              if (record !== null) {
                items.push(record);
              }
              continue;
            }

            const issueFiles = await readdir(join(firstLevelPath, childEntry));
            for (const issueFile of issueFiles) {
              const record = await readIssueStateFile(
                join(firstLevelPath, childEntry, issueFile),
              );
              if (record !== null) {
                items.push(record);
              }
            }
          }
        }

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
          const raw = await readFile(join(eventsRoot, file), 'utf8');
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
        }

        return envelopes;
      } catch {
        return [];
      }
    },
    async listEventEnvelopesForWorkItem(
      workItemKey: string,
      limit = 10,
    ): Promise<EventEnvelope[]> {
      const issueRef = issueRefFromWorkItemKey(workItemKey);
      if (issueRef === null) {
        return [];
      }
      const canonicalWorkItemKey = namespacedWorkItemKey(workItemKey, issueRef.source);

      const projection = await this.readIssueState(
        issueRef.repo,
        issueRef.issueNumber,
        issueRef.source,
      );
      const recentEventIds = projection?.wake.recentEventIds.slice(-limit) ?? [];
      const envelopes: EventEnvelope[] = [];

      for (const eventId of recentEventIds) {
        const envelope = await this.readEventEnvelope(eventId);
        if (envelope?.workItemKey === canonicalWorkItemKey) {
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
