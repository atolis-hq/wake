import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface TranscriptCapture {
  readonly workItemId: string;
  readonly runId: string;
  readonly cli: string;
  readonly timestamp: string;
  readonly text: string;
}

export interface TranscriptResponseCapture extends TranscriptCapture {
  readonly sessionId?: string | undefined;
}

export interface TranscriptGroup {
  readonly id: string;
  readonly kind: 'session' | 'run';
  readonly runIds: readonly string[];
}

export interface TranscriptMessage {
  readonly timestamp: string;
  readonly runId: string;
  readonly kind: 'prompt' | 'response';
  readonly text: string;
}

export class TranscriptStore {
  public constructor(private readonly transcriptsRoot: string) {}

  public async capturePrompt(capture: TranscriptCapture): Promise<void> {
    const timestamp = timestampForFile(capture.timestamp);
    const directory = this.stagingDirectory(capture.workItemId, capture.runId);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, messageFile(timestamp, capture.runId, 'prompt')),
      capture.text,
      'utf8',
    );
  }

  public async captureResponse(capture: TranscriptResponseCapture): Promise<void> {
    const timestamp = timestampForFile(capture.timestamp);
    const group =
      capture.sessionId === undefined
        ? runGroup(capture.runId)
        : sessionGroup(capture.cli, capture.sessionId);
    const destination = this.groupDirectory(capture.workItemId, group);
    const staging = this.stagingDirectory(capture.workItemId, capture.runId);
    await mkdir(destination, { recursive: true });

    const promptFiles = await filesOrEmpty(staging);
    for (const promptFile of promptFiles.filter((file) => file.endsWith('.prompt.txt'))) {
      await rename(join(staging, promptFile), join(destination, promptFile));
    }
    await rm(staging, { recursive: true, force: true });
    await writeFile(
      join(destination, messageFile(timestamp, capture.runId, 'response')),
      capture.text,
      'utf8',
    );
  }

  public async listGroups(workItemId: string): Promise<readonly TranscriptGroup[]> {
    const groups: TranscriptGroup[] = [];
    for (const name of await filesOrEmpty(this.workItemDirectory(workItemId))) {
      const parsed = parseGroup(name);
      if (parsed === undefined) continue;
      const messages = await this.readGroup(workItemId, name);
      groups.push({ ...parsed, runIds: [...new Set(messages.map((message) => message.runId))] });
    }
    return groups.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'session' ? -1 : 1;
      return left.id.localeCompare(right.id);
    });
  }

  public async readGroup(
    workItemId: string,
    groupId: string,
  ): Promise<readonly TranscriptMessage[]> {
    assertSegment(groupId, 'Transcript group ID');
    const messages: TranscriptMessage[] = [];
    const directory = this.groupDirectory(workItemId, groupId);
    for (const file of await filesOrEmpty(directory)) {
      const parsed = parseMessageFile(file);
      if (parsed === undefined) continue;
      messages.push({ ...parsed, text: await readFile(join(directory, file), 'utf8') });
    }
    return messages.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  }

  public async groupForRun(workItemId: string, runId: string): Promise<string | undefined> {
    for (const group of await this.listGroups(workItemId)) {
      if (group.runIds.includes(runId)) return group.id;
    }
    return undefined;
  }

  public async markWorkItemCleaned(
    workItemId: string,
    retentionMs: number,
    cleanedAt: string,
  ): Promise<void> {
    assertRetention(retentionMs);
    const directory = this.workItemDirectory(workItemId);
    if (retentionMs === 0) {
      await rm(directory, { recursive: true, force: true });
      return;
    }
    const timestamp = normaliseTimestamp(cleanedAt);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, '.cleaned-at'), timestamp, 'utf8');
  }

  public async sweepExpired(retentionMs: number, now: string): Promise<readonly string[]> {
    assertRetention(retentionMs);
    const currentTime = Date.parse(normaliseTimestamp(now));
    const expired: string[] = [];
    for (const workItemId of await filesOrEmpty(this.transcriptsRoot)) {
      const directory = this.workItemDirectory(workItemId);
      const marker = join(directory, '.cleaned-at');
      let cleanedAt: string;
      try {
        cleanedAt = await readFile(marker, 'utf8');
      } catch (error: unknown) {
        if (isMissing(error)) continue;
        throw error;
      }
      if (Date.parse(normaliseTimestamp(cleanedAt)) + retentionMs <= currentTime) {
        await rm(directory, { recursive: true });
        expired.push(workItemId);
      }
    }
    return expired.sort();
  }

  private workItemDirectory(workItemId: string): string {
    assertSegment(workItemId, 'Work item ID');
    return join(this.transcriptsRoot, workItemId);
  }

  private groupDirectory(workItemId: string, groupId: string): string {
    assertSegment(groupId, 'Transcript group ID');
    return join(this.workItemDirectory(workItemId), groupId);
  }

  private stagingDirectory(workItemId: string, runId: string): string {
    return join(this.workItemDirectory(workItemId), `.pending--${encodeURIComponent(runId)}`);
  }
}

function runGroup(runId: string): string {
  return `run--${safe(runId)}`;
}

function sessionGroup(cli: string, sessionId: string): string {
  return `session--${safe(cli)}--${safe(sessionId)}`;
}

function safe(value: string): string {
  return encodeURIComponent(value).replaceAll('-', '%2D');
}

function messageFile(timestamp: string, runId: string, kind: TranscriptMessage['kind']): string {
  return `${timestamp}.${encodeURIComponent(runId)}.${kind}.txt`;
}

function parseMessageFile(file: string): Omit<TranscriptMessage, 'text'> | undefined {
  const match =
    /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z)\.(.+)\.(prompt|response)\.txt$/.exec(file);
  if (match === null) return undefined;
  const [, fileTimestamp, encodedRunId, kind] = match;
  if (fileTimestamp === undefined || encodedRunId === undefined || kind === undefined)
    return undefined;
  return {
    timestamp: timestampFromFile(fileTimestamp),
    runId: decodeURIComponent(encodedRunId),
    kind: kind as TranscriptMessage['kind'],
  };
}

function parseGroup(id: string): Omit<TranscriptGroup, 'runIds'> | undefined {
  const session = /^session--(.+)--(.+)$/.exec(id);
  if (session?.[1] !== undefined && session[2] !== undefined) {
    return { id, kind: 'session' };
  }
  if (/^run--.+$/.test(id)) return { id, kind: 'run' };
  return undefined;
}

function timestampForFile(timestamp: string): string {
  return normaliseTimestamp(timestamp).replaceAll(':', '-');
}

function timestampFromFile(timestamp: string): string {
  return normaliseTimestamp(
    `${timestamp.slice(0, 13)}:${timestamp.slice(14, 16)}:${timestamp.slice(17)}`,
  );
}

function normaliseTimestamp(timestamp: string): string {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid transcript timestamp: ${timestamp}`);
  return parsed.toISOString();
}

function assertRetention(retentionMs: number): void {
  if (!Number.isInteger(retentionMs) || retentionMs < 0)
    throw new Error('Transcript retention must be a non-negative integer');
}

function assertSegment(value: string, label: string): void {
  if (
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\')
  ) {
    throw new Error(`${label} must be a single filesystem segment`);
  }
}

async function filesOrEmpty(directory: string): Promise<readonly string[]> {
  try {
    return await readdir(directory);
  } catch (error: unknown) {
    if (isMissing(error)) return [];
    throw error;
  }
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
