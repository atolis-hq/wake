import { access, appendFile, mkdir, readFile } from 'node:fs/promises';

import {
  parseEventRecord,
  parseIssueStateRecord,
  parseLedger,
  parseRunRecord,
  parseWakeConfig,
} from '../../domain/schema.js';
import type {
  EventRecord,
  IssueStateRecord,
  RunRecord,
  WakeConfig,
  WakeLedger,
} from '../../domain/types.js';
import { appendJsonLine, readJsonFile, writeJsonFile } from '../../lib/json-file.js';
import { createWakePaths } from '../../lib/paths.js';

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
    async readRunRecord(runId: string): Promise<RunRecord | null> {
      try {
        return parseRunRecord(await readJsonFile(paths.runFile(runId)));
      } catch {
        return null;
      }
    },
    async appendEvent(record: EventRecord): Promise<EventRecord> {
      const parsed = parseEventRecord(record);
      await appendJsonLine(paths.eventFile(parsed.occurredAt.slice(0, 10)), parsed);
      return parsed;
    },
    async appendLog(date: string, line: string): Promise<void> {
      await mkdir(wakeRoot, { recursive: true });
      await appendFile(paths.logFile(date), `${line}\n`, 'utf8');
    },
    async isPaused(): Promise<boolean> {
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
