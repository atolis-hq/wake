import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AgentAction, IssueStateRecord, WakeConfig } from '../../domain/types.js';
import { createWakePaths, sanitizePathKey } from '../../lib/paths.js';

type TranscriptKind = 'prompt' | 'response';

function resolveSessionKey(input: {
  projection: IssueStateRecord;
  runId: string;
  cli: string;
}): string {
  const priorSessionId = input.projection.wake.sessionId;
  const priorSessionCli = input.projection.wake.sessionCli;
  return priorSessionId !== undefined && priorSessionCli === input.cli
    ? priorSessionId
    : input.runId;
}

function transcriptFileName(input: {
  runId: string;
  kind: TranscriptKind;
  action: AgentAction;
  cli: string;
}): string {
  const cli = sanitizePathKey(input.cli.toLowerCase());
  return `${sanitizePathKey(input.runId)}.${cli}.${input.action}.${input.kind}.txt`;
}

export async function writeRunnerTranscript(input: {
  config: WakeConfig;
  projection: IssueStateRecord;
  runId: string;
  action: AgentAction;
  cli: string;
  kind: TranscriptKind;
  text: string;
}): Promise<string | undefined> {
  if (!input.config.transcripts.enabled) {
    return undefined;
  }

  const paths = createWakePaths(input.config.paths.wakeRoot);
  const sessionDir = paths.transcriptSessionDir(
    input.projection.issue.repo,
    input.projection.issue.number,
    resolveSessionKey(input),
  );
  const file = join(sessionDir, transcriptFileName(input));
  await mkdir(sessionDir, { recursive: true });
  await writeFile(file, input.text, 'utf8');
  return file;
}
