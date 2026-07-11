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
): { repo: string; issueNumber: number } | null {
  const marker = workItemKey.lastIndexOf('#');
  if (marker === -1) {
    return null;
  }

  const repo = workItemKey.slice(0, marker);
  const issueNumber = Number(workItemKey.slice(marker + 1));
  if (repo.length === 0 || !Number.isInteger(issueNumber) || issueNumber <= 0) {
    return null;
  }

  return { repo, issueNumber };
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
      await writeJsonFile(paths.issueStateFile(parsed.issue.repo, parsed.issue.number), parsed);
      return parsed;
    },
    async readIssueState(repo: string, issueNumber: number): Promise<IssueStateRecord | null> {
      try {
        return parseIssueStateRecord(await readJsonFile(paths.issueStateFile(repo, issueNumber)));
      } catch {
        return null;
      }
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

        for (const repoDir of repoDirs) {
          const issueFiles = await readdir(join(stateRoot, repoDir));
          for (const issueFile of issueFiles) {
            try {
              items.push(
                parseIssueStateRecord(
                  await readJsonFile(join(stateRoot, repoDir, issueFile)),
                ),
              );
            } catch {
              continue;
            }
          }
        }

        return items.sort((left, right) =>
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

      const projection = await this.readIssueState(issueRef.repo, issueRef.issueNumber);
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
    async isPaused(now = new Date()): Promise<boolean> {
      try {
        await access(paths.pauseFile);
        return true;
      } catch {
        const ledger = await this.readLedger();
        return ledger?.pausedUntil !== undefined && Date.parse(ledger.pausedUntil) > now.getTime();
      }
    },
    async readEventLog(date: string): Promise<string> {
      return readFile(paths.eventFile(date), 'utf8');
    },
  };
}
